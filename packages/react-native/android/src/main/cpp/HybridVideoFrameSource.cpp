//
//  HybridVideoFrameSource.cpp
//  supervision-js-react-native
//

#include "HybridVideoFrameSource.hpp"

#include "HybridVideoFrameHandle.hpp"

#include <android/log.h>
#include <fcntl.h>
#include <media/NdkImage.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cstring>
#include <stdexcept>

namespace margelo::nitro::supervision {

namespace {

constexpr const char* kLogTag = "VideoFrameSource";
constexpr int64_t kCodecTimeoutUs = 4000;

[[noreturn]] void fail(const std::string& message) {
  __android_log_print(ANDROID_LOG_ERROR, kLogTag, "%s", message.c_str());
  throw std::runtime_error("VideoFrameSource: " + message);
}

std::string stripFileScheme(const std::string& filePath) {
  constexpr const char* kScheme = "file://";
  if (filePath.rfind(kScheme, 0) == 0) {
    return filePath.substr(std::string(kScheme).size());
  }
  return filePath;
}

inline uint8_t clampToByte(int value) {
  return static_cast<uint8_t>(std::min(255, std::max(0, value)));
}

} // namespace

void HybridVideoFrameSource::open(const std::string& filePath) {
  {
    std::lock_guard<std::mutex> guard(_mutex);
    if (_opened) {
      fail("source is already open");
    }
  }

  const std::string path = stripFileScheme(filePath);
  const int fd = ::open(path.c_str(), O_RDONLY);
  if (fd < 0) {
    fail("file does not exist at " + path);
  }
  struct stat fileStat = {};
  if (fstat(fd, &fileStat) != 0) {
    ::close(fd);
    fail("cannot stat " + path);
  }

  AMediaExtractor* extractor = AMediaExtractor_new();
  const media_status_t sourceStatus = AMediaExtractor_setDataSourceFd(
      extractor, fd, 0, static_cast<off64_t>(fileStat.st_size));
  // The extractor keeps its own duplicate of the descriptor.
  ::close(fd);
  if (sourceStatus != AMEDIA_OK) {
    AMediaExtractor_delete(extractor);
    fail("failed to read media at " + path);
  }

  // Select the first video track.
  AMediaFormat* trackFormat = nullptr;
  const char* mime = nullptr;
  const size_t trackCount = AMediaExtractor_getTrackCount(extractor);
  for (size_t index = 0; index < trackCount; index += 1) {
    AMediaFormat* format = AMediaExtractor_getTrackFormat(extractor, index);
    const char* trackMime = nullptr;
    if (AMediaFormat_getString(format, AMEDIAFORMAT_KEY_MIME, &trackMime) &&
        trackMime != nullptr &&
        std::string(trackMime).rfind("video/", 0) == 0) {
      AMediaExtractor_selectTrack(extractor, index);
      trackFormat = format;
      mime = trackMime;
      break;
    }
    AMediaFormat_delete(format);
  }
  if (trackFormat == nullptr) {
    AMediaExtractor_delete(extractor);
    fail("no video track in " + path);
  }

  int32_t width = 0;
  int32_t height = 0;
  AMediaFormat_getInt32(trackFormat, AMEDIAFORMAT_KEY_WIDTH, &width);
  AMediaFormat_getInt32(trackFormat, AMEDIAFORMAT_KEY_HEIGHT, &height);
  int64_t durationUs = 0;
  AMediaFormat_getInt64(trackFormat, AMEDIAFORMAT_KEY_DURATION, &durationUs);
  int32_t frameRate = 0;
  AMediaFormat_getInt32(trackFormat, AMEDIAFORMAT_KEY_FRAME_RATE, &frameRate);

  // Decoded frames leave the reader exactly as stored; rotated content would
  // reach consumers sideways and silently break the mask coordinate
  // contract, so fail loudly until the GPU rotation pass lands. The string
  // literal avoids the API-28 AMEDIAFORMAT_KEY_ROTATION constant.
  int32_t rotation = 0;
  AMediaFormat_getInt32(trackFormat, "rotation-degrees", &rotation);
  if (rotation % 360 != 0) {
    AMediaFormat_delete(trackFormat);
    AMediaExtractor_delete(extractor);
    fail("rotated videos are not supported on Android yet (rotation=" +
         std::to_string(rotation) + ")");
  }

  if (width <= 0 || height <= 0) {
    AMediaFormat_delete(trackFormat);
    AMediaExtractor_delete(extractor);
    fail("video track has no dimensions in " + path);
  }

  // YUV_420_888 is the format MediaCodec actually renders into an
  // ImageReader surface (an RGBA reader rejects the buffers with
  // "Output buffer format: 0x23"). Each frame is converted to RGBA before it
  // reaches consumers; see the header note.
  // GPU_SAMPLED_IMAGE stays in the usage even though frames are read on the
  // CPU: the codec produces through the GPU/gralloc path and stalls without
  // a GPU-compatible consumer usage.
  AImageReader* reader = nullptr;
  const media_status_t readerStatus = AImageReader_newWithUsage(
      width, height, AIMAGE_FORMAT_YUV_420_888,
      AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE |
          AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN,
      kMaxImages, &reader);
  if (readerStatus != AMEDIA_OK || reader == nullptr) {
    AMediaFormat_delete(trackFormat);
    AMediaExtractor_delete(extractor);
    fail("failed to create image reader (" + std::to_string(readerStatus) +
         ")");
  }

  AImageReader_ImageListener listener{this,
                                      &HybridVideoFrameSource::onImageAvailable};
  AImageReader_setImageListener(reader, &listener);

  ANativeWindow* window = nullptr;
  AImageReader_getWindow(reader, &window);

  AMediaCodec* codec = AMediaCodec_createDecoderByType(mime);
  if (codec == nullptr) {
    AImageReader_delete(reader);
    AMediaFormat_delete(trackFormat);
    AMediaExtractor_delete(extractor);
    fail(std::string("no decoder available for ") + mime);
  }

  const media_status_t configureStatus =
      AMediaCodec_configure(codec, trackFormat, window, nullptr, 0);
  AMediaFormat_delete(trackFormat);
  if (configureStatus != AMEDIA_OK ||
      AMediaCodec_start(codec) != AMEDIA_OK) {
    AMediaCodec_delete(codec);
    AImageReader_delete(reader);
    AMediaExtractor_delete(extractor);
    fail("failed to start decoder (" + std::to_string(configureStatus) + ")");
  }

  {
    std::lock_guard<std::mutex> guard(_mutex);
    _extractor = extractor;
    _codec = codec;
    _reader = reader;
    _opened = true;
    _durationMs = static_cast<double>(durationUs) / 1000.0;
    _frameWidth = static_cast<double>(width);
    _frameHeight = static_cast<double>(height);
    _nominalFrameRate = static_cast<double>(frameRate);
  }

  _decodeThread = std::thread([this]() { decodeLoop(); });
}

void HybridVideoFrameSource::onImageAvailable(void* context,
                                              AImageReader* /* reader */) {
  auto* self = static_cast<HybridVideoFrameSource*>(context);
  {
    std::lock_guard<std::mutex> guard(self->_mutex);
    self->_availableImages += 1;
  }
  self->_condition.notify_all();
}

bool HybridVideoFrameSource::waitForRingSlot(
    std::unique_lock<std::mutex>& lock) {
  _condition.wait(lock, [this]() {
    return _closed || _ring.size() < static_cast<size_t>(kRingCapacity);
  });
  return !_closed;
}

AImage* HybridVideoFrameSource::acquireDecodedImage() {
  std::unique_lock<std::mutex> lock(_mutex);
  _condition.wait(lock, [this]() { return _closed || _availableImages > 0; });
  if (_closed) {
    return nullptr;
  }
  _availableImages -= 1;
  AImageReader* reader = _reader;
  lock.unlock();

  AImage* image = nullptr;
  const media_status_t status = AImageReader_acquireNextImage(reader, &image);
  if (status != AMEDIA_OK || image == nullptr) {
    __android_log_print(ANDROID_LOG_WARN, kLogTag,
                        "acquireNextImage failed (%d)", status);
    return nullptr;
  }
  return image;
}

AHardwareBuffer* HybridVideoFrameSource::convertImageToRgbaBuffer(
    AImage* image) {
  int32_t width = 0;
  int32_t height = 0;
  AImage_getWidth(image, &width);
  AImage_getHeight(image, &height);

  uint8_t* yData = nullptr;
  uint8_t* uData = nullptr;
  uint8_t* vData = nullptr;
  int yLength = 0;
  int uLength = 0;
  int vLength = 0;
  int32_t yRowStride = 0;
  int32_t uRowStride = 0;
  int32_t vRowStride = 0;
  int32_t yPixelStride = 0;
  int32_t uPixelStride = 0;
  int32_t vPixelStride = 0;

  if (AImage_getPlaneData(image, 0, &yData, &yLength) != AMEDIA_OK ||
      AImage_getPlaneData(image, 1, &uData, &uLength) != AMEDIA_OK ||
      AImage_getPlaneData(image, 2, &vData, &vLength) != AMEDIA_OK) {
    return nullptr;
  }
  AImage_getPlaneRowStride(image, 0, &yRowStride);
  AImage_getPlaneRowStride(image, 1, &uRowStride);
  AImage_getPlaneRowStride(image, 2, &vRowStride);
  AImage_getPlanePixelStride(image, 0, &yPixelStride);
  AImage_getPlanePixelStride(image, 1, &uPixelStride);
  AImage_getPlanePixelStride(image, 2, &vPixelStride);

  AHardwareBuffer_Desc desc = {};
  desc.width = static_cast<uint32_t>(width);
  desc.height = static_cast<uint32_t>(height);
  desc.layers = 1;
  desc.format = AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM;
  desc.usage = AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN |
               AHARDWAREBUFFER_USAGE_CPU_WRITE_OFTEN |
               AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE;

  AHardwareBuffer* rgbaBuffer = nullptr;
  if (AHardwareBuffer_allocate(&desc, &rgbaBuffer) != 0 ||
      rgbaBuffer == nullptr) {
    return nullptr;
  }

  void* mapped = nullptr;
  if (AHardwareBuffer_lock(rgbaBuffer, AHARDWAREBUFFER_USAGE_CPU_WRITE_OFTEN,
                           -1, nullptr, &mapped) != 0 ||
      mapped == nullptr) {
    AHardwareBuffer_release(rgbaBuffer);
    return nullptr;
  }

  AHardwareBuffer_Desc lockedDesc = {};
  AHardwareBuffer_describe(rgbaBuffer, &lockedDesc);
  const int32_t outRowPixels = static_cast<int32_t>(lockedDesc.stride);
  auto* out = static_cast<uint8_t*>(mapped);

  // BT.601 limited-range YUV420 -> RGBA. The generic pixel-stride indexing
  // covers planar (I420) and semi-planar (NV12/NV21) layouts. Plain integer
  // math is fast enough for an analysis-paced file session; a GPU blit is
  // the follow-up if device profiling shows this dominating the tick.
  for (int32_t row = 0; row < height; row += 1) {
    const uint8_t* yRow = yData + row * yRowStride;
    const int32_t chromaRow = row >> 1;
    uint8_t* outRow = out + static_cast<size_t>(row) * outRowPixels * 4;

    for (int32_t col = 0; col < width; col += 1) {
      const int32_t chromaCol = col >> 1;
      const int y = yRow[col * yPixelStride];
      const int u = uData[chromaRow * uRowStride + chromaCol * uPixelStride];
      const int v = vData[chromaRow * vRowStride + chromaCol * vPixelStride];

      const int c = 298 * (y - 16);
      const int d = u - 128;
      const int e = v - 128;

      uint8_t* pixel = outRow + col * 4;
      pixel[0] = clampToByte((c + 409 * e + 128) >> 8);
      pixel[1] = clampToByte((c - 100 * d - 208 * e + 128) >> 8);
      pixel[2] = clampToByte((c + 516 * d + 128) >> 8);
      pixel[3] = 255;
    }
  }

  AHardwareBuffer_unlock(rgbaBuffer, nullptr);
  return rgbaBuffer;
}

void HybridVideoFrameSource::decodeLoop() {
  bool inputDone = false;
  bool outputDone = false;

  while (!outputDone) {
    {
      std::unique_lock<std::mutex> lock(_mutex);
      if (_closed) {
        return;
      }
    }

    // Feed compressed samples while the extractor has them.
    if (!inputDone) {
      const ssize_t inputIndex =
          AMediaCodec_dequeueInputBuffer(_codec, kCodecTimeoutUs);
      if (inputIndex >= 0) {
        size_t capacity = 0;
        uint8_t* inputBuffer =
            AMediaCodec_getInputBuffer(_codec, inputIndex, &capacity);
        const ssize_t sampleSize =
            AMediaExtractor_readSampleData(_extractor, inputBuffer, capacity);
        if (sampleSize < 0) {
          AMediaCodec_queueInputBuffer(
              _codec, inputIndex, 0, 0, 0,
              AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM);
          inputDone = true;
        } else {
          const int64_t sampleTimeUs =
              AMediaExtractor_getSampleTime(_extractor);
          AMediaCodec_queueInputBuffer(_codec, inputIndex, 0,
                                       static_cast<size_t>(sampleSize),
                                       sampleTimeUs, 0);
          AMediaExtractor_advance(_extractor);
        }
      }
    }

    // Drain one decoded output. Rendering pushes the frame into the
    // AImageReader; it is converted to RGBA and returned to the reader
    // before entering the ring, so gate on ring capacity first, exactly like
    // the iOS decode loop blocks while its ring is full.
    AMediaCodecBufferInfo info = {};
    const ssize_t outputIndex =
        AMediaCodec_dequeueOutputBuffer(_codec, &info, kCodecTimeoutUs);
    if (outputIndex < 0) {
      continue;
    }

    const bool isEndOfStream =
        (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) != 0;
    const bool hasFrame = info.size > 0;

    if (hasFrame) {
      {
        std::unique_lock<std::mutex> lock(_mutex);
        if (!waitForRingSlot(lock)) {
          AMediaCodec_releaseOutputBuffer(_codec, outputIndex, false);
          return;
        }
        _pendingTimestampsUs.push_back(info.presentationTimeUs);
      }
      AMediaCodec_releaseOutputBuffer(_codec, outputIndex, true);

      AImage* image = acquireDecodedImage();
      AHardwareBuffer* rgbaBuffer = nullptr;
      if (image != nullptr) {
        rgbaBuffer = convertImageToRgbaBuffer(image);
        // The YUV image returns to the reader immediately; consumers only
        // ever see the converted RGBA buffer.
        AImage_delete(image);
      }

      {
        std::lock_guard<std::mutex> guard(_mutex);
        if (_closed) {
          if (rgbaBuffer != nullptr) {
            AHardwareBuffer_release(rgbaBuffer);
          }
          return;
        }
        if (rgbaBuffer == nullptr) {
          // The frame could not be acquired or converted; drop its timestamp
          // so pairing stays aligned for the frames that follow.
          __android_log_print(ANDROID_LOG_WARN, kLogTag,
                              "dropping frame at pts=%lldus",
                              static_cast<long long>(
                                  _pendingTimestampsUs.front()));
          _pendingTimestampsUs.pop_front();
        } else {
          const int64_t timestampUs = _pendingTimestampsUs.front();
          _pendingTimestampsUs.pop_front();
          _ring.push_back(
              {rgbaBuffer, static_cast<double>(timestampUs) / 1000.0});
          _condition.notify_all();
        }
      }
    } else {
      AMediaCodec_releaseOutputBuffer(_codec, outputIndex, false);
    }

    if (isEndOfStream) {
      outputDone = true;
    }
  }

  {
    std::lock_guard<std::mutex> guard(_mutex);
    _finished = true;
  }
  _condition.notify_all();
}

std::optional<std::shared_ptr<HybridVideoFrameHandleSpec>>
HybridVideoFrameSource::copyNextFrame() {
  std::unique_lock<std::mutex> lock(_mutex);
  if (!_opened) {
    fail("source has not been opened");
  }

  _condition.wait(lock, [this]() {
    return _closed || _finished || !_ring.empty();
  });
  if (_closed || _ring.empty()) {
    return std::nullopt;
  }

  const RingEntry next = _ring.front();
  _ring.pop_front();
  // Wake the decoder: a ring slot just freed up.
  _condition.notify_all();

  return std::make_shared<HybridVideoFrameHandle>(
      next.rgbaBuffer, next.timestampMs, _frameWidth, _frameHeight);
}

void HybridVideoFrameSource::close() {
  {
    std::lock_guard<std::mutex> guard(_mutex);
    if (_closed) {
      return;
    }
    _closed = true;
  }
  _condition.notify_all();

  if (_decodeThread.joinable()) {
    _decodeThread.join();
  }

  std::lock_guard<std::mutex> guard(_mutex);
  for (const RingEntry& entry : _ring) {
    AHardwareBuffer_release(entry.rgbaBuffer);
  }
  _ring.clear();
  teardownNativesLocked();
}

void HybridVideoFrameSource::teardownNativesLocked() {
  if (_codec != nullptr) {
    AMediaCodec_stop(_codec);
    AMediaCodec_delete(_codec);
    _codec = nullptr;
  }
  // Safe to delete directly: decoded AImages never escape the decode thread,
  // which has already been joined.
  if (_reader != nullptr) {
    AImageReader_setImageListener(_reader, nullptr);
    AImageReader_delete(_reader);
    _reader = nullptr;
  }
  if (_extractor != nullptr) {
    AMediaExtractor_delete(_extractor);
    _extractor = nullptr;
  }
}

HybridVideoFrameSource::~HybridVideoFrameSource() {
  close();
}

} // namespace margelo::nitro::supervision

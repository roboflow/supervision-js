//
//  HybridVideoFrameSource.hpp
//  supervision-js-react-native
//
//  Sequential NDK frame source: hardware-decodes a saved video through
//  AMediaExtractor + AMediaCodec into a YUV AImageReader, converts each frame
//  to a source-allocated RGBA AHardwareBuffer on the decode thread, and keeps
//  a small decode-ahead ring so decode overlaps the consumer's inference
//  work. Mirrors ios/HybridVideoFrameSource.swift.
//
//  Why the conversion step: MediaCodec renders YUV into an ImageReader
//  surface (an RGBA reader rejects the buffers), while ExecuTorch's Android
//  FrameExtractor only reads RGBA-family hardware buffers. The CPU convert
//  runs on the decode thread of an analysis-paced file session; a GPU blit
//  (which would also unlock rotated videos) is the documented follow-up if
//  profiling demands it.
//

#pragma once

#include "HybridVideoFrameSourceSpec.hpp"

#include <android/hardware_buffer.h>
#include <media/NdkImageReader.h>
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaExtractor.h>

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

namespace margelo::nitro::supervision {

class HybridVideoFrameSource : public HybridVideoFrameSourceSpec {
public:
  HybridVideoFrameSource() : HybridObject(TAG) {}
  ~HybridVideoFrameSource() override;

  double getDurationMs() override { return _durationMs; }
  double getFrameWidth() override { return _frameWidth; }
  double getFrameHeight() override { return _frameHeight; }
  double getNominalFrameRate() override { return _nominalFrameRate; }

  void open(const std::string& filePath) override;
  std::optional<std::shared_ptr<HybridVideoFrameHandleSpec>> copyNextFrame()
      override;
  void close() override;

private:
  /// Decode-ahead depth, matching the iOS ring.
  static constexpr int kRingCapacity = 3;
  /// The AImage is converted and returned to the reader on the decode thread,
  /// so only decode-ahead slack is needed here.
  static constexpr int kMaxImages = 4;

  struct RingEntry {
    AHardwareBuffer* rgbaBuffer;
    double timestampMs;
  };

  void decodeLoop();
  bool waitForRingSlot(std::unique_lock<std::mutex>& lock);
  AImage* acquireDecodedImage();
  /// Converts one decoded YUV_420_888 image into a freshly allocated RGBA
  /// AHardwareBuffer. Returns nullptr on failure. Does not delete the image.
  AHardwareBuffer* convertImageToRgbaBuffer(AImage* image);
  static void onImageAvailable(void* context, AImageReader* reader);
  void teardownNativesLocked();

  std::mutex _mutex;
  std::condition_variable _condition;
  std::deque<RingEntry> _ring;
  std::deque<int64_t> _pendingTimestampsUs;
  int _availableImages = 0;
  bool _finished = false;
  bool _closed = false;
  bool _opened = false;

  AMediaExtractor* _extractor = nullptr;
  AMediaCodec* _codec = nullptr;
  AImageReader* _reader = nullptr;
  std::thread _decodeThread;

  double _durationMs = 0;
  double _frameWidth = 0;
  double _frameHeight = 0;
  double _nominalFrameRate = 0;
};

} // namespace margelo::nitro::supervision

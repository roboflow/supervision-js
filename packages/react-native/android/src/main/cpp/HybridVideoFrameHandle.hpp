//
//  HybridVideoFrameHandle.hpp
//  supervision-js-react-native
//
//  One decoded, upright RGBA video frame backed by a source-allocated
//  AHardwareBuffer. Mirrors ios/HybridVideoFrameHandle.swift: the handle owns
//  one buffer reference and `release()` must run exactly once when the
//  presented packet that used it has been replaced (calling it more than once
//  is safe).
//
//  The buffer is allocated by the frame source (not acquired from the
//  decoder's AImageReader), so consumers get a CPU-lockable RGBA buffer that
//  both zero-copy consumers accept: ExecuTorch's FrameExtractor only reads
//  R8G8B8A8/R8G8B8X8/R8G8B8 hardware buffers, and Skia samples it on the GPU.
//

#pragma once

#include "HybridVideoFrameHandleSpec.hpp"

#include <android/hardware_buffer.h>

#include <atomic>
#include <cstdint>

namespace margelo::nitro::supervision {

class HybridVideoFrameHandle : public HybridVideoFrameHandleSpec {
public:
  /// Takes over one ownership reference of `buffer`.
  HybridVideoFrameHandle(AHardwareBuffer* buffer,
                         double timestampMs,
                         double width,
                         double height)
      : HybridObject(TAG),
        _buffer(buffer),
        _timestampMs(timestampMs),
        _width(width),
        _height(height) {}

  ~HybridVideoFrameHandle() override { releaseNow(); }

  uint64_t getPointer() override {
    return reinterpret_cast<uint64_t>(_buffer);
  }
  double getTimestampMs() override { return _timestampMs; }
  double getWidth() override { return _width; }
  double getHeight() override { return _height; }

  void release() override { releaseNow(); }

private:
  void releaseNow() {
    if (_released.exchange(true)) {
      return;
    }
    AHardwareBuffer_release(_buffer);
  }

  AHardwareBuffer* _buffer;
  double _timestampMs;
  double _width;
  double _height;
  std::atomic<bool> _released{false};
};

} // namespace margelo::nitro::supervision

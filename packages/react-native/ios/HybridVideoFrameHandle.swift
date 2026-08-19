//
//  HybridVideoFrameHandle.swift
//  supervision-js-react-native
//
//  One decoded, upright BGRA video frame. Retains its CVPixelBuffer until
//  release() balances the retain; consumers read `pointer` zero-copy
//  (ExecuTorch inference, Skia MakeImageFromNativeBuffer).
//

import CoreVideo
import Foundation
import NitroModules

final class HybridVideoFrameHandle: HybridVideoFrameHandleSpec {
  private var retained: Unmanaged<CVPixelBuffer>?
  let timestampMs: Double
  let width: Double
  let height: Double

  init(buffer: CVPixelBuffer, timestampMs: Double) {
    self.retained = Unmanaged.passRetained(buffer)
    self.timestampMs = timestampMs
    self.width = Double(CVPixelBufferGetWidth(buffer))
    self.height = Double(CVPixelBufferGetHeight(buffer))
    super.init()
  }

  var pointer: UInt64 {
    guard let retained else {
      return 0
    }
    return UInt64(UInt(bitPattern: retained.toOpaque()))
  }

  func release() throws {
    retained?.release()
    retained = nil
  }

  deinit {
    // Safety net: never leak the pixel buffer if JS drops the handle
    // without releasing it.
    retained?.release()
    retained = nil
  }
}

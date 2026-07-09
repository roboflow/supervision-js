//
//  HybridVideoFrameSource.swift
//  supervision-js-react-native
//
//  Sequential AVFoundation frame source: hardware-decodes a saved video into
//  upright BGRA CVPixelBuffers, keeping a small decode-ahead ring so decode
//  overlaps the consumer's inference work.
//

import AVFoundation
import Foundation
import NitroModules

final class HybridVideoFrameSource: HybridVideoFrameSourceSpec {
  /// Decode-ahead depth. Total outstanding buffers (ring + in-flight +
  /// one-packet retirement on the JS side) must stay well below the
  /// decoder's fixed pixel-buffer pool size to avoid stalling the reader.
  private static let ringCapacity = 3

  private let ringLock = NSCondition()
  private var ring: [(buffer: CVPixelBuffer, timestampMs: Double)] = []
  private var finished = false
  private var closed = false
  private var reader: AVAssetReader?
  private var output: AVAssetReaderVideoCompositionOutput?
  private let decodeQueue = DispatchQueue(
    label: "supervision.video.decode", qos: .userInitiated)

  var durationMs: Double = 0
  var frameWidth: Double = 0
  var frameHeight: Double = 0
  var nominalFrameRate: Double = 0

  func open(filePath: String) throws {
    let url: URL
    if filePath.hasPrefix("file://"), let parsed = URL(string: filePath) {
      url = parsed
    } else {
      url = URL(fileURLWithPath: filePath)
    }
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw RuntimeError.error(
        withMessage: "VideoFrameSource: file does not exist at \(url.path)")
    }

    let asset = AVURLAsset(url: url)

    // Nitro methods are synchronous; block this (caller-owned) thread while
    // the modern async loading APIs resolve.
    let semaphore = DispatchSemaphore(value: 0)
    var loadedTrack: AVAssetTrack?
    var loadedDuration = CMTime.zero
    var loadedFrameRate: Float = 0
    var loadedComposition: AVMutableVideoComposition?
    var loadError: Error?

    Task.detached(priority: .userInitiated) {
      do {
        let tracks = try await asset.loadTracks(withMediaType: .video)
        guard let track = tracks.first else {
          throw RuntimeError.error(
            withMessage: "VideoFrameSource: no video track in \(url.lastPathComponent)")
        }
        loadedTrack = track
        loadedDuration = try await asset.load(.duration)
        loadedFrameRate = try await track.load(.nominalFrameRate)
        // The composition bakes preferredTransform, so decoded frames come
        // out upright and no orientation plumbing is needed downstream.
        // The pod's deployment target follows React Native's minimum, so the
        // iOS 16+ async API needs an availability guard.
        if #available(iOS 16.0, *) {
          loadedComposition = try await AVMutableVideoComposition.videoComposition(
            withPropertiesOf: asset)
        } else {
          loadedComposition = AVMutableVideoComposition(propertiesOf: asset)
        }
      } catch {
        loadError = error
      }
      semaphore.signal()
    }
    semaphore.wait()

    if let loadError {
      throw RuntimeError.error(
        withMessage: "VideoFrameSource: failed to load asset: \(loadError.localizedDescription)")
    }
    guard let track = loadedTrack, let composition = loadedComposition else {
      throw RuntimeError.error(
        withMessage: "VideoFrameSource: no video track in \(url.lastPathComponent)")
    }

    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderVideoCompositionOutput(
      videoTracks: [track],
      videoSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        // IOSurface backing enables zero-copy GPU import in Skia.
        kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
      ])
    output.videoComposition = composition
    output.alwaysCopiesSampleData = false

    guard reader.canAdd(output) else {
      throw RuntimeError.error(
        withMessage: "VideoFrameSource: cannot attach video output")
    }
    reader.add(output)
    guard reader.startReading() else {
      throw RuntimeError.error(
        withMessage:
          "VideoFrameSource: failed to start reading (\(reader.error?.localizedDescription ?? "unknown"))")
    }

    self.reader = reader
    self.output = output
    durationMs = loadedDuration.seconds * 1000
    frameWidth = Double(composition.renderSize.width)
    frameHeight = Double(composition.renderSize.height)
    nominalFrameRate = Double(loadedFrameRate)

    decodeQueue.async { [weak self] in
      self?.decodeLoop()
    }
  }

  private func decodeLoop() {
    while true {
      ringLock.lock()
      while ring.count >= Self.ringCapacity, !closed {
        ringLock.wait()
      }
      if closed {
        ringLock.unlock()
        return
      }
      ringLock.unlock()

      guard let output,
            let sample = output.copyNextSampleBuffer(),
            let imageBuffer = CMSampleBufferGetImageBuffer(sample) else {
        ringLock.lock()
        finished = true
        ringLock.broadcast()
        ringLock.unlock()
        return
      }

      let timestampMs =
        CMSampleBufferGetPresentationTimeStamp(sample).seconds * 1000

      ringLock.lock()
      ring.append((imageBuffer, timestampMs))
      ringLock.broadcast()
      ringLock.unlock()
    }
  }

  func copyNextFrame() throws -> (any HybridVideoFrameHandleSpec)? {
    ringLock.lock()
    defer { ringLock.unlock() }

    while ring.isEmpty, !finished, !closed {
      ringLock.wait()
    }
    if closed || ring.isEmpty {
      return nil
    }

    let next = ring.removeFirst()

    // Wake the decoder: a ring slot just freed up.
    ringLock.broadcast()

    return HybridVideoFrameHandle(
      buffer: next.buffer, timestampMs: next.timestampMs)
  }

  func close() throws {
    ringLock.lock()
    closed = true
    ring.removeAll()
    ringLock.broadcast()
    ringLock.unlock()

    reader?.cancelReading()
    reader = nil
    output = nil
  }

  deinit {
    try? close()
  }
}

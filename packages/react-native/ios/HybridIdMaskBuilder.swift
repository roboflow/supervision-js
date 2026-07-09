//
//  HybridIdMaskBuilder.swift
//  supervision-js-react-native
//
//  Native fill loop for live detection-indexed Alpha_8 ID-mask artifacts.
//  Must stay byte-identical to `createReactNativeLiveIdMaskArtifact()` in
//  `src/index.ts`: same artifact sizing, declaration-order overlap behavior,
//  palette layout, limits, and empty/invalid-mask handling. Masks are drawn
//  exactly as the model produced them (nearest sampling, no reshaping).
//

import Foundation
import NitroModules

class HybridIdMaskBuilder: HybridIdMaskBuilderSpec {
  func createArtifact(options: IdMaskBuildOptions) throws -> IdMaskBuildArtifact {
    guard options.maxPaletteEntries.isFinite, options.maxPaletteEntries >= 2 else {
      throw RuntimeError.error(
        withMessage: "IdMaskBuilder: maxPaletteEntries must be at least 2 (got \(options.maxPaletteEntries))")
    }
    guard options.frameWidth.isFinite, options.frameHeight.isFinite,
          options.maxPixels.isFinite, options.maxSide.isFinite else {
      throw RuntimeError.error(
        withMessage: "IdMaskBuilder: frame and artifact bounds must be finite "
          + "(frame \(options.frameWidth)x\(options.frameHeight), "
          + "maxPixels \(options.maxPixels), maxSide \(options.maxSide))")
    }

    let fillStartedAt = DispatchTime.now()
    // Bridged struct properties can convert on access; resolve the detections
    // array exactly once.
    let allDetections = options.detections
    let maxPaletteEntries = Int(options.maxPaletteEntries)
    let detectionLimit = maxPaletteEntries - 1
    let detectionCount = min(allDetections.count, detectionLimit)

    // Artifact sizing mirrors resolveReactNativeLiveIdMaskArtifactSize().
    let frameWidth = max(1.0, options.frameWidth.rounded())
    let frameHeight = max(1.0, options.frameHeight.rounded())
    let framePixels = frameWidth * frameHeight
    let areaScale = framePixels > options.maxPixels
      ? (options.maxPixels / framePixels).squareRoot()
      : 1.0
    let sideScale = min(1.0, options.maxSide / frameWidth, options.maxSide / frameHeight)
    let scale = min(areaScale, sideScale)
    let width = max(1, Int((frameWidth * scale).rounded()))
    let height = max(1, Int((frameHeight * scale).rounded()))

    let dataBuffer = ArrayBuffer.allocate(size: width * height, initializeToZero: true)
    let paletteFloatCount = maxPaletteEntries * 4
    let fillPaletteBuffer = ArrayBuffer.allocate(
      size: paletteFloatCount * MemoryLayout<Float32>.size, initializeToZero: true)
    let strokePaletteBuffer = ArrayBuffer.allocate(
      size: paletteFloatCount * MemoryLayout<Float32>.size, initializeToZero: true)
    let strokeWidthsBuffer = ArrayBuffer.allocate(
      size: maxPaletteEntries * MemoryLayout<Float32>.size, initializeToZero: true)

    let data = dataBuffer.data
    let fillPalette = UnsafeMutableRawPointer(fillPaletteBuffer.data)
      .assumingMemoryBound(to: Float32.self)
    let strokePalette = UnsafeMutableRawPointer(strokePaletteBuffer.data)
      .assumingMemoryBound(to: Float32.self)
    let strokeWidths = UnsafeMutableRawPointer(strokeWidthsBuffer.data)
      .assumingMemoryBound(to: Float32.self)

    let strokeWidth = min(max(0.0, options.borderWidth), options.maxStrokeWidth)
    let strokeAlpha: Float32 = strokeWidth > 0 ? 0.95 : 0
    var maskCount = 0
    var maxCellTexels = 0.0

    for index in 0..<detectionCount {
      let detection = allDetections[index]

      guard detection.maskWidth.isFinite, detection.maskHeight.isFinite,
            detection.bbox.x1.isFinite, detection.bbox.y1.isFinite,
            detection.bbox.x2.isFinite, detection.bbox.y2.isFinite else {
        throw RuntimeError.error(
          withMessage: "IdMaskBuilder: detection \(index) has non-finite mask or bbox dimensions")
      }

      // Same skip rule as the JS builder: masks whose byte length does not
      // match their dimensions never render (and never consume a palette id).
      let maskWidth = Int(detection.maskWidth)
      let maskHeight = Int(detection.maskHeight)
      guard detection.maskWidth == Double(maskWidth),
            detection.maskHeight == Double(maskHeight),
            maskWidth >= 0, maskHeight >= 0,
            detection.mask.size == maskWidth * maskHeight else {
        continue
      }

      let maskId = index + 1
      let paletteOffset = maskId * 4
      let color = Int(detection.color)
      let red = Float32(Double((color >> 16) & 0xff) / 255.0)
      let green = Float32(Double((color >> 8) & 0xff) / 255.0)
      let blue = Float32(Double(color & 0xff) / 255.0)

      fillPalette[paletteOffset] = red
      fillPalette[paletteOffset + 1] = green
      fillPalette[paletteOffset + 2] = blue
      fillPalette[paletteOffset + 3] = 1
      strokePalette[paletteOffset] = red
      strokePalette[paletteOffset + 1] = green
      strokePalette[paletteOffset + 2] = blue
      strokePalette[paletteOffset + 3] = strokeAlpha
      strokeWidths[maskId] = Float32(strokeWidth)

      let targetX0 = Int(max(0.0, (detection.bbox.x1 * scale).rounded(.down)))
      let targetY0 = Int(max(0.0, (detection.bbox.y1 * scale).rounded(.down)))
      let targetX1 = Int(min(Double(width), (detection.bbox.x2 * scale).rounded(.up)))
      let targetY1 = Int(min(Double(height), (detection.bbox.y2 * scale).rounded(.up)))
      let targetWidth = targetX1 - targetX0
      let targetHeight = targetY1 - targetY0

      guard targetWidth > 0, targetHeight > 0 else {
        continue
      }

      maskCount += 1

      guard maskWidth > 0, maskHeight > 0 else {
        continue
      }

      // Logical (upright) mask dims: rotated buffers report rotated dims.
      let logicalMaskWidth = detection.maskRotatedCw ? maskHeight : maskWidth
      let logicalMaskHeight = detection.maskRotatedCw ? maskWidth : maskHeight

      maxCellTexels = max(
        maxCellTexels,
        Double(targetWidth) / Double(logicalMaskWidth),
        Double(targetHeight) / Double(logicalMaskHeight))

      let maskData = detection.mask.data
      let fillValue = UInt8(truncatingIfNeeded: maskId)

      fillDetectionNearest(
        data: data, maskData: maskData,
        maskWidth: logicalMaskWidth, maskHeight: logicalMaskHeight,
        rotatedCw: detection.maskRotatedCw, storedRowWidth: maskWidth,
        targetX0: targetX0, targetY0: targetY0,
        targetWidth: targetWidth, targetHeight: targetHeight,
        artifactWidth: width, fillValue: fillValue)
    }

    let fillNanoseconds = DispatchTime.now().uptimeNanoseconds - fillStartedAt.uptimeNanoseconds

    return IdMaskBuildArtifact(
      data: dataBuffer,
      edgeFeatherTexels: min(12.0, max(1.0, maxCellTexels / 2.0)),
      fillMs: Double(fillNanoseconds) / 1_000_000.0,
      fillPalette: fillPaletteBuffer,
      hasStroke: strokeWidth > 0,
      height: Double(height),
      maskCount: Double(maskCount),
      maxStrokeWidth: strokeWidth,
      opacity: options.fillOpacity,
      scale: scale,
      strokePalette: strokePaletteBuffer,
      strokeWidths: strokeWidthsBuffer,
      width: Double(width)
    )
  }

  private func fillDetectionNearest(
    data: UnsafeMutablePointer<UInt8>,
    maskData: UnsafeMutablePointer<UInt8>,
    maskWidth: Int, maskHeight: Int,
    rotatedCw: Bool, storedRowWidth: Int,
    targetX0: Int, targetY0: Int,
    targetWidth: Int, targetHeight: Int,
    artifactWidth: Int, fillValue: UInt8
  ) {
    let sourceXStep = Double(maskWidth) / Double(targetWidth)
    let sourceYStep = Double(maskHeight) / Double(targetHeight)

    // Column source indices are identical for every row of this detection;
    // precompute them once so the hot loop stays add-and-compare only.
    var sourceXMap = [Int](repeating: 0, count: targetWidth)
    for x in 0..<targetWidth {
      sourceXMap[x] = min(maskWidth - 1, Int((Double(x) * sourceXStep).rounded(.down)))
    }

    sourceXMap.withUnsafeBufferPointer { sourceX in
      for y in 0..<targetHeight {
        let sourceY = min(maskHeight - 1, Int((Double(y) * sourceYStep).rounded(.down)))
        let targetRowOffset = (targetY0 + y) * artifactWidth + targetX0

        if rotatedCw {
          // Buffer stores the mask rotated 90° clockwise:
          // logical(x, y) = stored[x * storedRowWidth + (storedRowWidth-1-y)]
          let rotatedColumn = storedRowWidth - 1 - sourceY

          for x in 0..<targetWidth {
            if maskData[sourceX[x] * storedRowWidth + rotatedColumn] != 0 {
              data[targetRowOffset + x] = fillValue
            }
          }
        } else {
          let sourceRowOffset = sourceY * maskWidth

          for x in 0..<targetWidth {
            if maskData[sourceRowOffset + sourceX[x]] != 0 {
              data[targetRowOffset + x] = fillValue
            }
          }
        }
      }
    }
  }

}

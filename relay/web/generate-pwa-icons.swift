// Re-export the approved desktop artwork for PWA installation, without its
// desktop padding/corner mask. Run on macOS: swift generate-pwa-icons.swift
// (from any directory). The original resources/icon.png is never modified.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let web = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let root = web.deletingLastPathComponent().deletingLastPathComponent()
let sourceURL = root.appendingPathComponent("resources/icon.png")
guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0,
        [kCGImageSourceShouldCache: false] as CFDictionary),
      image.width == 1024, image.height == 1024,
      image.bitsPerComponent == 8, image.bitsPerPixel == 32,
      image.alphaInfo == .last,
      let sourceData = image.dataProvider?.data else {
  fatalError("Expected the approved 1024px RGBA master at \(sourceURL.path)")
}

// The master retains the original red background's RGB even under its
// transparent corner mask. Read those channels directly instead of drawing
// over white/black (which would bake a border into the installed icon).
// These bounds match the approved full-bleed preview, inside the edge fringe.
let offset = 102
let edge = 820
let rgba = [UInt8](sourceData as Data)
var rgb = [UInt8](repeating: 0, count: edge * edge * 3)
for y in 0..<edge {
  for x in 0..<edge {
    let s = (y + offset) * image.bytesPerRow + (x + offset) * 4
    let d = (y * edge + x) * 3
    rgb[d] = rgba[s]
    rgb[d + 1] = rgba[s + 1]
    rgb[d + 2] = rgba[s + 2]
  }
}
let colorSpace = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!
let provider = CGDataProvider(data: Data(rgb) as CFData)!
let square = CGImage(width: edge, height: edge, bitsPerComponent: 8,
  bitsPerPixel: 24, bytesPerRow: edge * 3, space: colorSpace,
  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
  provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)!

for (name, size) in [("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)] {
  let context = CGContext(data: nil, width: size, height: size,
    bitsPerComponent: 8, bytesPerRow: size * 4, space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  context.interpolationQuality = .high
  context.draw(square, in: CGRect(x: 0, y: 0, width: size, height: size))
  let output = web.appendingPathComponent("public/\(name)")
  let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, context.makeImage()!, nil)
  precondition(CGImageDestinationFinalize(destination), "Could not write \(output.path)")
  print("\(name): \(size)×\(size), opaque RGB")
}

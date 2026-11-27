import AppKit
import CoreGraphics

func cocoaPointFromCG(_ point: CGPoint, primaryHeight: CGFloat) -> CGPoint {
  CGPoint(x: point.x, y: primaryHeight - point.y)
}

struct CursorTheme {
  let accent: NSColor
  let onAccent: NSColor
  let body: [NSColor]
  let sheen: NSColor
  let edge: NSColor
  let rimHi: NSColor
  let rimLo: NSColor
  let shade: NSColor
  let glow: NSColor

  static func hex(_ value: String, fallback: NSColor) -> NSColor {
    var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.hasPrefix("#") { text.removeFirst() }
    guard text.count == 6, let number = UInt32(text, radix: 16) else { return fallback }
    return NSColor(
      srgbRed: CGFloat((number >> 16) & 0xff) / 255,
      green: CGFloat((number >> 8) & 0xff) / 255,
      blue: CGFloat(number & 0xff) / 255,
      alpha: 1
    )
  }

  static func mix(_ base: NSColor, _ percent: CGFloat, _ other: NSColor) -> NSColor {
    let a = base.usingColorSpace(.sRGB) ?? base
    let b = other.usingColorSpace(.sRGB) ?? other
    return NSColor(
      srgbRed: a.redComponent * percent + b.redComponent * (1 - percent),
      green: a.greenComponent * percent + b.greenComponent * (1 - percent),
      blue: a.blueComponent * percent + b.blueComponent * (1 - percent),
      alpha: a.alphaComponent * percent + b.alphaComponent * (1 - percent)
    )
  }

  static func alpha(_ color: NSColor, _ value: CGFloat) -> NSColor {
    (color.usingColorSpace(.sRGB) ?? color).withAlphaComponent(value)
  }

  static func make(accentHex: String, onAccentHex: String, fallbackAccent: NSColor) -> CursorTheme {
    let accent = hex(accentHex, fallback: fallbackAccent)
    let black = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
    let white = NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
    return CursorTheme(
      accent: accent,
      onAccent: hex(onAccentHex, fallback: white),
      body: [
        mix(accent, 0.46, black),
        mix(accent, 0.24, black),
        mix(accent, 0.10, black),
        mix(accent, 0.04, black),
      ],
      sheen: mix(accent, 0.24, white),
      edge: mix(accent, 0.16, white),
      rimHi: mix(accent, 0.46, white),
      rimLo: mix(accent, 0.64, black),
      shade: mix(accent, 0.06, black),
      glow: alpha(accent, 0.38)
    )
  }

  static let dark = make(accentHex: "#00e5ff", onAccentHex: "#111111", fallbackAccent: .systemTeal)
  static let light = make(accentHex: "#006bd6", onAccentHex: "#ffffff", fallbackAccent: .systemBlue)
}

func cursorGradient(_ colors: [NSColor], _ locations: [CGFloat]) -> CGGradient? {
  let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
  let cgColors = colors.map { ($0.usingColorSpace(.sRGB) ?? $0).cgColor } as CFArray
  return CGGradient(colorsSpace: space, colors: cgColors, locations: locations)
}

final class CursorView: NSView {
  static let glyphD = "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"
  static let edgeD = "M5.1 5.4 10.9 19.4"
  static let glyphSize: CGFloat = 26
  static let viewBox: CGFloat = 24

  var theme = CursorTheme.dark
  var alpha: CGFloat = 0
  var sweepPhase: CGFloat = 0
  var ripples: [CGFloat] = []

  private let scale = CursorView.glyphSize / CursorView.viewBox
  private lazy var glyph: CGPath = (try? parseSvgPath(CursorView.glyphD)) ?? CGMutablePath()
  private lazy var edge: CGPath = (try? parseSvgPath(CursorView.edgeD)) ?? CGMutablePath()

  override var isFlipped: Bool { true }
  override var isOpaque: Bool { false }

  var anchor: CGPoint {
    CGPoint(x: bounds.width * 0.34, y: bounds.height * 0.30)
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext, alpha > 0.001 else { return }
    ctx.saveGState()
    ctx.setAlpha(alpha)
    drawRipples(ctx)
    drawPointer(ctx)
    ctx.restoreGState()
  }

  private func drawRipples(_ ctx: CGContext) {
    guard !ripples.isEmpty else { return }
    let center = anchor
    for age in ripples {
      let t = min(1, max(0, age))
      let radius = CursorView.glyphSize * 0.34 * (0.45 + 2.45 * CursorView.easeOut(t))
      let width = 2 * (1 - t) + 0.6
      ctx.saveGState()
      ctx.setStrokeColor(CursorTheme.alpha(theme.accent, 0.8 * (1 - t)).cgColor)
      ctx.setLineWidth(width)
      ctx.addEllipse(in: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
      ctx.strokePath()
      ctx.restoreGState()
    }
  }

  private func drawPointer(_ ctx: CGContext) {
    let anchor = self.anchor
    let scale = self.scale

    ctx.saveGState()
    ctx.translateBy(x: anchor.x, y: anchor.y)
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: -4.4, y: -4.9)

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 1.8), blur: 4.6, color: CursorTheme.alpha(.black, 0.5).cgColor)
    ctx.addPath(glyph)
    ctx.setFillColor(CursorTheme.alpha(theme.accent, 0.55).cgColor)
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.setShadow(offset: .zero, blur: 10, color: theme.glow.cgColor)
    ctx.addPath(glyph)
    ctx.setFillColor(theme.glow.cgColor)
    ctx.fillPath()
    ctx.restoreGState()

    if let gradient = cursorGradient(theme.body, [0, 0.34, 0.68, 1]) {
      ctx.saveGState()
      ctx.addPath(glyph)
      ctx.clip()
      ctx.drawLinearGradient(gradient, start: CGPoint(x: 4, y: 4), end: CGPoint(x: 20, y: 21), options: [])
      ctx.restoreGState()
    }

    if let gradient = cursorGradient(
      [CursorTheme.alpha(theme.sheen, 0.92), CursorTheme.alpha(theme.rimHi, 0.42), CursorTheme.alpha(theme.accent, 0)],
      [0, 0.42, 1]
    ) {
      ctx.saveGState()
      ctx.addPath(glyph)
      ctx.clip()
      ctx.translateBy(x: 7.4, y: 9.6)
      ctx.rotate(by: 28 * .pi / 180)
      ctx.addEllipse(in: CGRect(x: -5.4, y: -8.6, width: 10.8, height: 17.2))
      ctx.clip()
      ctx.drawLinearGradient(
        gradient,
        start: CGPoint(x: -5.4 * cos(28 * .pi / 180), y: -8.6),
        end: CGPoint(x: 5.4 * cos(28 * .pi / 180), y: 8.6),
        options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
      )
      ctx.restoreGState()
    }

    if let gradient = cursorGradient(
      [CursorTheme.alpha(theme.shade, 0.72), CursorTheme.alpha(theme.shade, 0.18), CursorTheme.alpha(theme.shade, 0)],
      [0, 0.6, 1]
    ) {
      ctx.saveGState()
      ctx.addPath(glyph)
      ctx.clip()
      ctx.drawLinearGradient(gradient, start: CGPoint(x: 20, y: 21), end: CGPoint(x: 10, y: 10), options: [])
      ctx.restoreGState()
    }

    drawSweep(ctx)

    if let gradient = cursorGradient(
      [CursorTheme.alpha(theme.edge, 0.85), CursorTheme.alpha(theme.rimHi, 0.35), CursorTheme.alpha(theme.accent, 0)],
      [0, 0.45, 1]
    ) {
      ctx.saveGState()
      ctx.addPath(glyph)
      ctx.clip()
      ctx.addPath(edge)
      ctx.setLineWidth(1.05)
      ctx.setLineCap(.round)
      ctx.replacePathWithStrokedPath()
      ctx.clip()
      ctx.drawLinearGradient(gradient, start: CGPoint(x: 5.1, y: 5.4), end: CGPoint(x: 10.9, y: 19.4), options: [])
      ctx.restoreGState()
    }

    if let gradient = cursorGradient(
      [CursorTheme.alpha(theme.rimHi, 0.95), CursorTheme.alpha(theme.accent, 0.72), CursorTheme.alpha(theme.rimLo, 0.55)],
      [0, 0.5, 1]
    ) {
      ctx.saveGState()
      ctx.addPath(glyph)
      ctx.setLineWidth(0.9)
      ctx.setLineJoin(.round)
      ctx.replacePathWithStrokedPath()
      ctx.clip()
      ctx.drawLinearGradient(gradient, start: CGPoint(x: 4, y: 4), end: CGPoint(x: 21, y: 21), options: [])
      ctx.restoreGState()
    }

    ctx.restoreGState()
  }

  private func drawSweep(_ ctx: CGContext) {
    let (opacity, offset) = CursorView.sweepState(sweepPhase)
    guard opacity > 0.001 else { return }
    guard
      let gradient = cursorGradient(
        [
          CursorTheme.alpha(theme.rimHi, 0),
          CursorTheme.alpha(theme.rimHi, 0.72 * opacity),
          CursorTheme.alpha(theme.rimHi, 0),
        ],
        [0, 0.5, 1]
      )
    else { return }
    ctx.saveGState()
    ctx.addPath(glyph)
    ctx.clip()
    let center = 12 + offset
    ctx.drawLinearGradient(
      gradient,
      start: CGPoint(x: center - 32, y: 0),
      end: CGPoint(x: center + 32, y: 0),
      options: []
    )
    ctx.restoreGState()
  }

  static func sweepState(_ phase: CGFloat) -> (opacity: CGFloat, offset: CGFloat) {
    let cycle = phase - floor(phase)
    let travelEnd: CGFloat = 0.46
    let fadeIn: CGFloat = 0.14
    guard cycle < travelEnd else { return (0, 16) }
    let progress = cycle / travelEnd
    let eased = smoothstep(progress)
    let offset = -16 + 32 * eased
    let opacity: CGFloat = cycle < fadeIn ? 0.9 * (cycle / fadeIn) : 0.9 * (1 - (cycle - fadeIn) / (travelEnd - fadeIn))
    return (max(0, opacity), offset)
  }

  static func smoothstep(_ t: CGFloat) -> CGFloat {
    let x = min(1, max(0, t))
    return x * x * (3 - 2 * x)
  }

  static func easeOut(_ t: CGFloat) -> CGFloat {
    let x = min(1, max(0, t))
    return 1 - (1 - x) * (1 - x)
  }
}

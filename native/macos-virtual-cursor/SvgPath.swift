import CoreGraphics
import Foundation

enum SvgPathError: Error {
  case unsupportedCommand(Character)
  case malformed(String)
}

private func svgTokens(_ d: String) -> [String] {
  var out: [String] = []
  var current = ""
  for ch in d {
    if ch.isLetter {
      if !current.isEmpty {
        out.append(current)
        current = ""
      }
      out.append(String(ch))
    } else if ch == "," || ch == " " || ch == "\n" || ch == "\t" || ch == "\r" {
      if !current.isEmpty {
        out.append(current)
        current = ""
      }
    } else {
      if (ch == "." && current.contains(".")) || ((ch == "-" || ch == "+") && !current.isEmpty) {
        out.append(current)
        current = ""
      }
      current.append(ch)
    }
  }
  if !current.isEmpty { out.append(current) }
  return out
}

private func arcSegments(
  from p0: CGPoint,
  to p1: CGPoint,
  rx rxIn: CGFloat,
  ry ryIn: CGFloat,
  rotationDeg: CGFloat,
  largeArc: Bool,
  sweep: Bool
) -> [(CGPoint, CGPoint, CGPoint)] {
  var rx = abs(rxIn)
  var ry = abs(ryIn)
  if rx == 0 || ry == 0 { return [] }
  if p0.x == p1.x && p0.y == p1.y { return [] }
  let phi = rotationDeg * .pi / 180
  let cosPhi = cos(phi)
  let sinPhi = sin(phi)
  let dx2 = (p0.x - p1.x) / 2
  let dy2 = (p0.y - p1.y) / 2
  let x1p = cosPhi * dx2 + sinPhi * dy2
  let y1p = -sinPhi * dx2 + cosPhi * dy2
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if lambda > 1 {
    let scale = sqrt(lambda)
    rx *= scale
    ry *= scale
  }
  let sign: CGFloat = largeArc != sweep ? 1 : -1
  let numerator = max(0, rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p)
  let denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let coefficient = denominator == 0 ? 0 : sign * sqrt(numerator / denominator)
  let cxp = coefficient * (rx * y1p / ry)
  let cyp = coefficient * (-(ry * x1p / rx))
  let cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2
  let cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2

  func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
    let dot = ux * vx + uy * vy
    let len = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
    let base = len == 0 ? 0 : acos(max(-1, min(1, dot / len)))
    return ux * vy - uy * vx < 0 ? -base : base
  }

  let ux = (x1p - cxp) / rx
  let uy = (y1p - cyp) / ry
  let vx = (-x1p - cxp) / rx
  let vy = (-y1p - cyp) / ry
  let theta1 = angle(1, 0, ux, uy)
  var delta = angle(ux, uy, vx, vy)
  if !sweep && delta > 0 { delta -= 2 * .pi }
  if sweep && delta < 0 { delta += 2 * .pi }

  let count = max(1, Int(ceil(abs(delta) / (.pi / 2))))
  let step = delta / CGFloat(count)
  let handle = 4 / 3 * tan(step / 4)
  var segments: [(CGPoint, CGPoint, CGPoint)] = []
  var theta = theta1
  var px = p0.x
  var py = p0.y

  for _ in 0..<count {
    let next = theta + step
    func pointAt(_ c: CGFloat, _ s: CGFloat) -> CGPoint {
      CGPoint(x: cx + cosPhi * rx * c - sinPhi * ry * s, y: cy + sinPhi * rx * c + cosPhi * ry * s)
    }
    func derivativeAt(_ c: CGFloat, _ s: CGFloat) -> CGPoint {
      CGPoint(x: -cosPhi * rx * s - sinPhi * ry * c, y: -sinPhi * rx * s + cosPhi * ry * c)
    }
    let end = pointAt(cos(next), sin(next))
    let d1 = derivativeAt(cos(theta), sin(theta))
    let d2 = derivativeAt(cos(next), sin(next))
    let c1 = CGPoint(x: px + handle * d1.x, y: py + handle * d1.y)
    let c2 = CGPoint(x: end.x - handle * d2.x, y: end.y - handle * d2.y)
    segments.append((c1, c2, end))
    px = end.x
    py = end.y
    theta = next
  }
  return segments
}

func parseSvgPath(_ d: String) throws -> CGPath {
  let tokens = svgTokens(d)
  let path = CGMutablePath()
  var index = 0
  var command: Character = "M"
  var current = CGPoint.zero
  var start = CGPoint.zero
  var lastControl: CGPoint?

  func number() throws -> CGFloat {
    guard index < tokens.count, let value = Double(tokens[index]) else {
      throw SvgPathError.malformed("expected a number at token \(index) of \(d)")
    }
    index += 1
    return CGFloat(value)
  }

  func flag() throws -> Bool {
    guard index < tokens.count else { throw SvgPathError.malformed("expected a flag") }
    let token = tokens[index]
    if token == "0" || token == "1" {
      index += 1
      return token == "1"
    }
    if let value = Double(token) {
      index += 1
      return value != 0
    }
    throw SvgPathError.malformed("expected an arc flag")
  }

  while index < tokens.count {
    if tokens[index].count == 1, let letter = tokens[index].first, letter.isLetter {
      command = letter
      index += 1
    }
    let relative = command.isLowercase
    switch Character(command.lowercased()) {
    case "m":
      let x = try number()
      let y = try number()
      current = relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
      start = current
      path.move(to: current)
      lastControl = nil
      command = relative ? "l" : "L"
    case "l":
      let x = try number()
      let y = try number()
      current = relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
      path.addLine(to: current)
      lastControl = nil
    case "h":
      let x = try number()
      current = CGPoint(x: relative ? current.x + x : x, y: current.y)
      path.addLine(to: current)
      lastControl = nil
    case "v":
      let y = try number()
      current = CGPoint(x: current.x, y: relative ? current.y + y : y)
      path.addLine(to: current)
      lastControl = nil
    case "a":
      let rx = try number()
      let ry = try number()
      let rotation = try number()
      let largeArc = try flag()
      let sweep = try flag()
      let x = try number()
      let y = try number()
      let end = relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
      for (c1, c2, point) in arcSegments(
        from: current,
        to: end,
        rx: rx,
        ry: ry,
        rotationDeg: rotation,
        largeArc: largeArc,
        sweep: sweep
      ) {
        path.addCurve(to: point, control1: c1, control2: c2)
      }
      current = end
      lastControl = nil
    case "c":
      let c1x = try number()
      let c1y = try number()
      let c2x = try number()
      let c2y = try number()
      let x = try number()
      let y = try number()
      let c1 = relative ? CGPoint(x: current.x + c1x, y: current.y + c1y) : CGPoint(x: c1x, y: c1y)
      let c2 = relative ? CGPoint(x: current.x + c2x, y: current.y + c2y) : CGPoint(x: c2x, y: c2y)
      let end = relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
      path.addCurve(to: end, control1: c1, control2: c2)
      current = end
      lastControl = c2
    case "z":
      path.closeSubpath()
      current = start
      lastControl = nil
    default:
      throw SvgPathError.unsupportedCommand(command)
    }
  }
  _ = lastControl
  return path
}

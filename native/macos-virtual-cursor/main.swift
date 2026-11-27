import AppKit
import CoreGraphics
import Foundation

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else {
    return
  }
  FileHandle.standardOutput.write(Data((text + "\n").utf8))
}

private func number(_ args: [String: Any], _ key: String) -> CGFloat? {
  if let value = args[key] as? Double { return CGFloat(value) }
  if let value = args[key] as? Int { return CGFloat(value) }
  if let value = args[key] as? NSNumber { return CGFloat(truncating: value) }
  return nil
}

private func text(_ args: [String: Any], _ key: String) -> String? {
  args[key] as? String
}

final class OverlayController {
  static let shared = OverlayController()

  private let panelSize = CGSize(width: 132, height: 132)
  private let anchorFraction = CGPoint(x: 0.30, y: 0.26)
  private let idleHideSeconds: TimeInterval = 15 * 60
  private let fadeInSeconds: TimeInterval = 0.12
  private let fadeOutSeconds: TimeInterval = 0.18
  private let sweepSeconds: TimeInterval = 3.8
  private let rippleSeconds: TimeInterval = 0.5

  private var panel: NSPanel?
  private var view: CursorView?
  private var timer: Timer?
  private var buffer = Data()
  private var active = false
  private var visible = false
  private var fadingOut = false
  private var fade: CGFloat = 0
  private var target = CGPoint.zero
  private var current = CGPoint.zero
  private var lastCommandAt = Date()
  private var lastTickAt = Date()
  private var sweepPhase: CGFloat = 0
  private var rippleStarts: [TimeInterval] = []
  private var paused = false
  private lazy var tips = TipsController(send: emit)

  func start() {
    let contentRect = NSRect(origin: .zero, size: panelSize)
    let panel = NSPanel(
      contentRect: contentRect,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = .screenSaver
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.ignoresMouseEvents = true
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.animationBehavior = .none
    panel.sharingType = .none
    let view = CursorView(frame: contentRect)
    panel.contentView = view
    self.panel = panel
    self.view = view

    let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
      self?.tick()
    }
    RunLoop.main.add(timer, forMode: .common)
    self.timer = timer

    FileHandle.standardInput.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      if data.isEmpty {
        DispatchQueue.main.async { self?.shutdown(reason: "eof") }
        return
      }
      self?.ingest(data)
    }
  }

  private func ingest(_ data: Data) {
    buffer.append(data)
    while let index = buffer.firstIndex(of: 0x0a) {
      let lineData = buffer.subdata(in: buffer.startIndex..<index)
      buffer.removeSubrange(buffer.startIndex...index)
      guard !lineData.isEmpty else { continue }
      guard
        let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
        let command = object["cmd"] as? String
      else { continue }
      let args = object["args"] as? [String: Any] ?? [:]
      DispatchQueue.main.async { [weak self] in
        self?.handle(command, args)
      }
    }
  }

  private func handle(_ command: String, _ args: [String: Any]) {
    lastCommandAt = Date()
    switch command {
    case "begin":
      begin()
    case "move":
      if let x = number(args, "x"), let y = number(args, "y") {
        moveTo(CGPoint(x: x, y: y))
      }
    case "click":
      if let x = number(args, "x"), let y = number(args, "y") {
        moveTo(CGPoint(x: x, y: y))
        current = target
      }
      rippleStarts.append(Date().timeIntervalSinceReferenceDate)
    case "theme":
      applyTheme(args)
      tips.handle(command, args)
    case "pause":
      paused = true
      if current != .zero, !active || fadingOut {
        fadingOut = false
        begin()
      }
    case "resume":
      paused = false
    case "tip.show", "tip.settle", "tip.hide":
      tips.handle(command, args)
    case "end":
      paused = false
      end()
    case "quit":
      shutdown(reason: "quit")
    default:
      break
    }
  }

  private func applyTheme(_ args: [String: Any]) {
    let dark = (args["dark"] as? Bool) ?? true
    let fallback = dark ? CursorTheme.dark : CursorTheme.light
    let accent = text(args, "accent") ?? ""
    let onAccent = text(args, "onAccent") ?? ""
    view?.theme = CursorTheme.make(
      accentHex: accent,
      onAccentHex: onAccent,
      fallbackAccent: fallback.accent
    )
    view?.needsDisplay = true
  }

  private func begin() {
    if active {
      fadingOut = false
      return
    }
    active = true
    fadingOut = false
    sweepPhase = 0
    lastTickAt = Date()
    panel?.alphaValue = 1
    view?.alpha = 0
    panel?.orderFrontRegardless()
    visible = true
  }

  private func moveTo(_ point: CGPoint) {
    if !active { begin() }
    if current == .zero {
      current = point
    }
    target = point
  }

  private func end() {
    guard active, !fadingOut else { return }
    fadingOut = true
  }

  private func tick() {
    let now = Date()
    let dt = min(0.1, now.timeIntervalSince(lastTickAt))
    lastTickAt = now

    guard active, let panel, let view else {
      if visible, !active {
        panel?.orderOut(nil)
        visible = false
      }
      return
    }

    fade = fadingOut
      ? max(0, fade - CGFloat(dt / fadeOutSeconds))
      : min(1, fade + CGFloat(dt / fadeInSeconds))

    let smoothing = 1 - exp(-dt / 0.055)
    current.x += (target.x - current.x) * CGFloat(smoothing)
    current.y += (target.y - current.y) * CGFloat(smoothing)
    if abs(target.x - current.x) < 0.15 { current.x = target.x }
    if abs(target.y - current.y) < 0.15 { current.y = target.y }

    if paused {
      sweepPhase = 0.6
    } else {
      sweepPhase += CGFloat(dt / sweepSeconds)
      if sweepPhase > 1 { sweepPhase -= floor(sweepPhase) }
    }

    let time = now.timeIntervalSinceReferenceDate
    rippleStarts.removeAll { time - $0 > rippleSeconds }
    view.ripples = rippleStarts.map { CGFloat((time - $0) / rippleSeconds) }
    view.sweepPhase = sweepPhase
    view.alpha = paused ? fade * 0.78 : fade
    view.needsDisplay = true

    place(panel: panel, at: current)

    if fade <= 0 && fadingOut {
      finish()
      return
    }

    if !paused, now.timeIntervalSince(lastCommandAt) > idleHideSeconds {
      end()
    }
  }

  private func place(panel: NSPanel, at point: CGPoint) {
    let cocoa = cocoaPoint(point)
    let origin = CGPoint(
      x: cocoa.x - panelSize.width * anchorFraction.x,
      y: cocoa.y - (panelSize.height - panelSize.height * anchorFraction.y)
    )
    panel.setFrameOrigin(origin)
  }

  private func cocoaPoint(_ point: CGPoint) -> CGPoint {
    cocoaPointFromCG(point, primaryHeight: primaryScreenHeight())
  }

  private func primaryScreenHeight() -> CGFloat {
    let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.screens.first
    return primary?.frame.height ?? 0
  }

  private func finish() {
    active = false
    fadingOut = false
    fade = 0
    view?.alpha = 0
    panel?.orderOut(nil)
    visible = false
  }

  func shutdown(reason: String) {
    if active {
      finish()
    }
    tips.shutdown()
    timer?.invalidate()
    timer = nil
    FileHandle.standardInput.readabilityHandler = nil
    emit(["event": "closed", "reason": reason])
    exit(0)
  }
}

if CommandLine.arguments.contains("--selftest") {
  let cases: [(cg: CGPoint, primary: CGFloat, cocoa: CGPoint)] = [
    (CGPoint(x: 900, y: 600), 1117, CGPoint(x: 900, y: 517)),
    (CGPoint(x: 0, y: 0), 1117, CGPoint(x: 0, y: 1117)),
    (CGPoint(x: 1200, y: -300), 1117, CGPoint(x: 1200, y: 1417)),
    (CGPoint(x: -250, y: 300), 900, CGPoint(x: -250, y: 600)),
  ]
  var failures = 0
  for item in cases {
    let got = cocoaPointFromCG(item.cg, primaryHeight: item.primary)
    if abs(got.x - item.cocoa.x) > 0.001 || abs(got.y - item.cocoa.y) > 0.001 {
      failures += 1
      emit([
        "event": "selftest.fail",
        "cg": [item.cg.x, item.cg.y],
        "primary": item.primary,
        "got": [got.x, got.y],
        "want": [item.cocoa.x, item.cocoa.y],
      ])
    }
  }
  let visible = CGRect(x: 0, y: 25, width: 1440, height: 850)
  let card = CGSize(width: 340, height: 180)
  let layouts: [(anchor: CGRect?, want: CGPoint)] = [
    (CGRect(x: 200, y: 300, width: 300, height: 60), CGPoint(x: 518, y: 261.6)),
    (CGRect(x: 1100, y: 300, width: 300, height: 60), CGPoint(x: 742, y: 261.6)),
    (CGRect(x: 100, y: 100, width: 1240, height: 60), CGPoint(x: 550, y: 178)),
    (CGRect(x: 10, y: 0, width: 1420, height: 840), CGPoint(x: 1086, y: 35)),
    (nil, CGPoint(x: 1086, y: 35)),
    (CGRect(x: 1300, y: 760, width: 120, height: 40), CGPoint(x: 942, y: 683)),
  ]
  for item in layouts {
    let got = TipLayout.origin(card: card, anchor: item.anchor, visible: visible)
    if abs(got.x - item.want.x) > 0.01 || abs(got.y - item.want.y) > 0.01 {
      failures += 1
      emit(["event": "selftest.fail", "layout": [got.x, got.y], "want": [item.want.x, item.want.y]])
    }
  }
  let screens = NSScreen.screens.map { screen -> [String: Any] in
    [
      "origin": [screen.frame.origin.x, screen.frame.origin.y],
      "height": screen.frame.height,
      "scale": screen.backingScaleFactor,
    ]
  }
  emit(["event": "selftest", "cases": cases.count + layouts.count, "failures": failures, "screens": screens])
  exit(failures == 0 ? 0 : 1)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
OverlayController.shared.start()
emit(["event": "ready", "version": "1"])
app.run()

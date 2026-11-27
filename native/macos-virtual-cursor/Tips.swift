import AppKit
import WebKit

enum TipLayout {
  static let margin: CGFloat = 12
  static let gap: CGFloat = 18

  static func corner(card: CGSize, visible: CGRect) -> CGPoint {
    clamp(CGPoint(x: visible.maxX - card.width - 14, y: visible.minY + 10), card: card, visible: visible)
  }

  static func origin(card: CGSize, anchor: CGRect?, visible: CGRect) -> CGPoint {
    guard let t = anchor, t.width * t.height <= visible.width * visible.height * 0.35 else {
      return corner(card: card, visible: visible)
    }
    let point: CGPoint
    if t.maxX + gap + card.width <= visible.maxX - margin {
      point = CGPoint(x: t.maxX + gap, y: t.midY - card.height * 0.38)
    } else if t.minX - gap - card.width >= visible.minX + margin {
      point = CGPoint(x: t.minX - gap - card.width, y: t.midY - card.height * 0.38)
    } else if t.maxY + gap + card.height <= visible.maxY - margin {
      point = CGPoint(x: t.midX - card.width / 2, y: t.maxY + gap)
    } else if t.minY - gap - card.height >= visible.minY + margin {
      point = CGPoint(x: t.midX - card.width / 2, y: t.minY - gap - card.height)
    } else {
      return corner(card: card, visible: visible)
    }
    return clamp(point, card: card, visible: visible)
  }

  static func clamp(_ point: CGPoint, card: CGSize, visible: CGRect) -> CGPoint {
    CGPoint(
      x: min(max(point.x, visible.minX + margin), max(visible.minX + margin, visible.maxX - card.width - margin)),
      y: min(max(point.y, visible.minY + 8), max(visible.minY + 8, visible.maxY - card.height - margin))
    )
  }
}

final class TipWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class TipPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class SpotView: NSView {
  static let margin: CGFloat = 26
  private let ring = CAShapeLayer()
  private let halo = CAShapeLayer()

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.addSublayer(halo)
    layer?.addSublayer(ring)
  }

  required init?(coder: NSCoder) { nil }

  func configure(color: NSColor, dim: Bool) {
    let inner = bounds.insetBy(dx: SpotView.margin, dy: SpotView.margin)
    guard inner.width > 0, inner.height > 0 else { return }
    let rgb = color.usingColorSpace(.sRGB) ?? color
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for item in [ring, halo] {
      item.frame = bounds
      item.fillColor = nil
    }
    ring.path = CGPath(roundedRect: inner, cornerWidth: 10, cornerHeight: 10, transform: nil)
    ring.strokeColor = rgb.withAlphaComponent(0.8).cgColor
    ring.lineWidth = 2
    ring.shadowColor = rgb.cgColor
    ring.shadowRadius = 12
    ring.shadowOpacity = 0.4
    ring.shadowOffset = .zero
    halo.path = CGPath(roundedRect: inner.insetBy(dx: -4, dy: -4), cornerWidth: 14, cornerHeight: 14, transform: nil)
    halo.strokeColor = rgb.withAlphaComponent(0.14).cgColor
    halo.lineWidth = 6
    CATransaction.commit()
    halo.removeAllAnimations()
    ring.removeAllAnimations()
    alphaValue = dim ? 0.45 : 1
    guard !dim, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
    let width = CABasicAnimation(keyPath: "lineWidth")
    width.fromValue = 6
    width.toValue = 14
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1
    fade.toValue = 0.35
    let group = CAAnimationGroup()
    group.animations = [width, fade]
    group.duration = 1.3
    group.autoreverses = true
    group.repeatCount = .infinity
    group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    halo.add(group, forKey: "pulse")
    let glow = CABasicAnimation(keyPath: "shadowOpacity")
    glow.fromValue = 0.4
    glow.toValue = 0.2
    glow.duration = 1.3
    glow.autoreverses = true
    glow.repeatCount = .infinity
    ring.add(glow, forKey: "glow")
  }
}

private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ target: WKScriptMessageHandler) { self.target = target }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}

final class TipsController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  private enum Phase { case waiting, settled, dismissing }

  private let send: ([String: Any]) -> Void
  private var panel: TipPanel?
  private var web: TipWebView?
  private var spotPanel: NSPanel?
  private var spotView: SpotView?
  private var loaded = false
  private var queued: [String] = []
  private var tipId: String?
  private var anchor: CGRect?
  private var corner = false
  private var danger = false
  private var spotlight = true
  private var mode = ""
  private var cardOrigin: CGPoint?
  private var phase: Phase = .waiting
  private var ownerPID: pid_t?
  private var activationObserver: NSObjectProtocol?
  private var accent = NSColor(srgbRed: 0, green: 229 / 255, blue: 1, alpha: 1)
  private var dark = true
  private var themeArgs: [String: Any]?

  init(send: @escaping ([String: Any]) -> Void) {
    self.send = send
    super.init()
    activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.refreshVisibility()
    }
  }

  deinit {
    if let activationObserver {
      NSWorkspace.shared.notificationCenter.removeObserver(activationObserver)
    }
  }

  private var capturable: Bool {
    ProcessInfo.processInfo.environment["JELLYBOT_TIPS_CAPTURABLE"] == "1"
  }

  private func ensureViews() {
    guard panel == nil else { return }
    let config = WKWebViewConfiguration()
    config.userContentController.add(WeakScriptHandler(self), name: "tips")
    let web = TipWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 260), configuration: config)
    web.setValue(false, forKey: "drawsBackground")
    web.navigationDelegate = self
    if #available(macOS 13.3, *) {
      web.isInspectable = ProcessInfo.processInfo.environment["JELLYBOT_TIPS_INSPECT"] == "1"
    }
    let panel = TipPanel(
      contentRect: web.frame,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    configure(panel)
    panel.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)
    panel.ignoresMouseEvents = false
    panel.acceptsMouseMovedEvents = true
    panel.becomesKeyOnlyIfNeeded = true
    panel.isFloatingPanel = true
    panel.contentView = web
    self.panel = panel
    self.web = web

    let spotPanel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 100, height: 100),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    configure(spotPanel)
    spotPanel.level = .screenSaver
    spotPanel.ignoresMouseEvents = true
    let spotView = SpotView(frame: spotPanel.contentLayoutRect)
    spotView.autoresizingMask = [.width, .height]
    spotPanel.contentView = spotView
    self.spotPanel = spotPanel
    self.spotView = spotView

    web.loadHTMLString(tipsPageHTML, baseURL: nil)
    if let themeArgs { call("theme", themeArgs) }
  }

  private func configure(_ panel: NSPanel) {
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.animationBehavior = .none
    panel.sharingType = capturable ? .readOnly : .none
  }

  func handle(_ command: String, _ args: [String: Any]) {
    switch command {
    case "tip.show":
      ensureViews()
      guard let id = args["id"] as? String else { return }
      shutdown()
      tipId = id
      ownerPID = (args["owner_pid"] as? NSNumber).map { $0.int32Value }
      anchor = rect(args["anchor"])
      corner = (args["place"] as? String) == "corner"
      danger = (args["danger"] as? Bool) == true
      spotlight = (args["spotlight"] as? Bool) != false
      mode = ""
      phase = .waiting
      cardOrigin = nil
      call("show", args)
    case "tip.settle":
      guard (args["id"] as? String) == tipId else { return }
      phase = .settled
      call("settle", args)
      hideSpot()
    case "tip.hide":
      guard tipId != nil, (args["id"] as? String) == nil || (args["id"] as? String) == tipId else { return }
      phase = .dismissing
      call("hide", args)
      hideSpot()
    case "theme":
      themeArgs = args
      dark = (args["dark"] as? Bool) ?? true
      let fallback = dark ? CursorTheme.dark.accent : CursorTheme.light.accent
      accent = CursorTheme.hex((args["accent"] as? String) ?? "", fallback: fallback)
      if panel != nil { call("theme", args) }
      if spotPanel?.isVisible == true { updateSpot(dim: mode == "pill") }
    default:
      break
    }
  }

  func shutdown() {
    panel?.orderOut(nil)
    spotPanel?.orderOut(nil)
  }

  private func call(_ function: String, _ args: [String: Any]) {
    guard
      let data = try? JSONSerialization.data(withJSONObject: args),
      let json = String(data: data, encoding: .utf8)
    else { return }
    let script = "window.tips && window.tips.\(function)(\(json));"
    if loaded {
      web?.evaluateJavaScript(script, completionHandler: nil)
    } else {
      queued.append(script)
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    loaded = true
    let scripts = queued
    queued.removeAll()
    for script in scripts { webView.evaluateJavaScript(script, completionHandler: nil) }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    loaded = false
    if let id = tipId { send(["event": "tip.lost", "id": id]) }
    tipId = nil
    shutdown()
    webView.loadHTMLString(tipsPageHTML, baseURL: nil)
    if let themeArgs { call("theme", themeArgs) }
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "size":
      guard
        let id = body["id"] as? String, id == tipId, phase != .dismissing,
        let width = number(body["w"]), let height = number(body["h"]),
        let top = number(body["top"]), let right = number(body["right"]),
        let bottom = number(body["bottom"]), let left = number(body["left"])
      else { return }
      let next = (body["mode"] as? String) ?? "card"
      guard (next == "done") == (phase == .settled) else { return }
      layout(
        card: CGSize(width: width, height: height),
        insets: NSEdgeInsets(top: top, left: left, bottom: bottom, right: right),
        mode: next
      )
    case "answer":
      guard let id = body["id"] as? String, id == tipId else { return }
      var event: [String: Any] = ["event": "tip.answer", "id": id, "action": (body["action"] as? String) ?? "primary"]
      if let choice = number(body["choice"]) { event["choice"] = Int(choice) }
      send(event)
    case "hidden":
      let id = body["id"] as? String
      guard id == nil || id == tipId else { return }
      shutdown()
      tipId = nil
    default:
      break
    }
  }

  private func layout(card: CGSize, insets: NSEdgeInsets, mode next: String) {
    guard let panel else { return }
    let (visible, display) = screenRects()
    var origin: CGPoint
    if let current = cardOrigin, next == mode || next == "done" {
      origin = TipLayout.clamp(current, card: card, visible: visible)
    } else if next == "pill" {
      origin = TipLayout.corner(card: card, visible: visible)
    } else {
      origin = corner ? TipLayout.corner(card: card, visible: visible) : TipLayout.origin(card: card, anchor: anchor, visible: visible)
    }
    let left = display.minX + insets.left
    let top = display.minY + insets.top
    origin.x = min(max(origin.x, left), max(left, display.maxX - card.width - insets.right))
    origin.y = min(max(origin.y, top), max(top, display.maxY - card.height - insets.bottom))
    let modeChanged = next != mode
    mode = next
    cardOrigin = origin
    let frame = CGRect(x: origin.x - insets.left, y: origin.y - insets.top,
                       width: card.width + insets.left + insets.right,
                       height: card.height + insets.top + insets.bottom)
    panel.setFrame(cocoaRect(frame), display: true)
    refreshVisibility(updateSpotlight: modeChanged)
  }

  private func refreshVisibility(updateSpotlight: Bool = false) {
    guard let panel, tipId != nil, !mode.isEmpty else { return }
    if let ownerPID, NSWorkspace.shared.frontmostApplication?.processIdentifier == ownerPID {
      shutdown()
      return
    }
    guard phase != .dismissing else { return }
    if phase == .waiting, spotlight, anchor != nil, let spotPanel {
      if updateSpotlight || !spotPanel.isVisible { updateSpot(dim: mode == "pill") }
      if !spotPanel.isVisible { spotPanel.orderFrontRegardless() }
    }
    if !panel.isVisible { panel.orderFrontRegardless() }
  }

  private func updateSpot(dim: Bool) {
    guard let spotPanel, let spotView else { return }
    guard spotlight, let anchor else {
      hideSpot()
      return
    }
    let frame = anchor.insetBy(dx: -(6 + SpotView.margin), dy: -(6 + SpotView.margin))
    spotPanel.setFrame(cocoaRect(frame), display: false)
    spotView.frame = NSRect(origin: .zero, size: frame.size)
    let color = danger
      ? (dark ? NSColor(srgbRed: 229 / 255, green: 83 / 255, blue: 75 / 255, alpha: 1) : NSColor(srgbRed: 201 / 255, green: 54 / 255, blue: 54 / 255, alpha: 1))
      : accent
    spotView.configure(color: color, dim: dim)
  }

  private func hideSpot() {
    spotPanel?.orderOut(nil)
  }

  private func screenRects() -> (visible: CGRect, display: CGRect) {
    let primary = primaryHeight()
    let screens = NSScreen.screens
    let point: CGPoint = anchor.map { CGPoint(x: $0.midX, y: $0.midY) } ?? {
      let mouse = NSEvent.mouseLocation
      return CGPoint(x: mouse.x, y: primary - mouse.y)
    }()
    let screen = screens.first { cgRect($0.frame, primary: primary).contains(point) } ?? NSScreen.main ?? screens.first
    guard let screen else {
      let fallback = CGRect(x: 0, y: 0, width: 1440, height: 900)
      return (fallback, fallback)
    }
    return (cgRect(screen.visibleFrame, primary: primary), cgRect(screen.frame, primary: primary))
  }

  private func cgRect(_ cocoa: NSRect, primary: CGFloat) -> CGRect {
    CGRect(x: cocoa.minX, y: primary - cocoa.maxY, width: cocoa.width, height: cocoa.height)
  }

  private func cocoaRect(_ cg: CGRect) -> NSRect {
    NSRect(x: cg.minX, y: primaryHeight() - cg.maxY, width: cg.width, height: cg.height)
  }

  private func primaryHeight() -> CGFloat {
    let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.screens.first
    return primary?.frame.height ?? 0
  }

  private func rect(_ value: Any?) -> CGRect? {
    guard
      let dict = value as? [String: Any],
      let x = number(dict["x"]), let y = number(dict["y"]),
      let width = number(dict["width"]), let height = number(dict["height"]),
      width > 0, height > 0
    else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
  }

  private func number(_ value: Any?) -> CGFloat? {
    if let value = value as? Double { return CGFloat(value) }
    if let value = value as? Int { return CGFloat(value) }
    if let value = value as? NSNumber { return CGFloat(truncating: value) }
    return nil
  }
}

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import Security
import Vision

private let helperVersion = "1"
private let maxDepthDefault = 15
private let maxNodesDefault = 8000

private typealias Args = [String: Any]
private typealias Object = [String: Any]

private struct HelperError: Error {
    let code: String
    let message: String
}

private func fail(_ code: String, _ message: String) -> HelperError {
    HelperError(code: code, message: message)
}

private let ownPid = Int(getpid())

private func rejectOwnApp(_ pid: Int, _ surface: String) throws {
    guard pid == ownPid else { return }
    throw fail(
        "self_target",
        "Refusing to read JellyBot's own accessibility tree from \(surface): the in-process AX request re-enters Electron off the main thread and traps the app. Target the other app instead, or use computer_screen for our own window."
    )
}

private let outputLock = NSLock()

private func encodeObject(_ object: Object) -> String {
    if JSONSerialization.isValidJSONObject(object),
       let encoded = try? JSONSerialization.data(withJSONObject: object, options: []) {
        return String(decoding: encoded, as: UTF8.self)
    }
    return "{\"ok\":false,\"code\":\"native_error\",\"error\":\"Could not encode helper response.\"}"
}

private func emit(_ object: Object) {
    let data = Data(encodeObject(object).utf8)
    outputLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    outputLock.unlock()
}

private func num(_ a: Args, _ key: String) -> Double? {
    (a[key] as? NSNumber)?.doubleValue
}

private func str(_ a: Args, _ key: String) -> String? {
    a[key] as? String
}

private func flag(_ a: Args, _ key: String, _ fallback: Bool) -> Bool {
    (a[key] as? NSNumber)?.boolValue ?? fallback
}

private func r1(_ value: Double) -> Double {
    (value * 10).rounded() / 10
}

private func pointObject(_ p: CGPoint) -> Object {
    ["x": r1(Double(p.x)), "y": r1(Double(p.y))]
}

private func rectObject(_ r: CGRect) -> Object {
    ["x": r1(Double(r.origin.x)), "y": r1(Double(r.origin.y)), "width": r1(Double(r.width)), "height": r1(Double(r.height))]
}

private func nullable(_ value: Any?) -> Any {
    value ?? NSNull()
}

private func screens() -> [Object] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
    let main = CGMainDisplayID()
    return ids.prefix(Int(count)).map { id in
        let bounds = CGDisplayBounds(id)
        var scale = 1.0
        if let mode = CGDisplayCopyDisplayMode(id), bounds.width > 0, mode.pixelWidth > 0 {
            scale = Double(mode.pixelWidth) / Double(bounds.width)
        }
        var screen = rectObject(bounds)
        screen["id"] = Int(id)
        screen["is_main"] = id == main
        screen["scale"] = (scale * 1000).rounded() / 1000
        screen["pixels_wide"] = Int((Double(bounds.width) * scale).rounded())
        screen["pixels_high"] = Int((Double(bounds.height) * scale).rounded())
        return screen
    }
}

private func permissions(prompt: Bool) -> Object {
    let accessibility = prompt
        ? AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        : AXIsProcessTrusted()
    var capture = CGPreflightScreenCaptureAccess()
    if prompt && !capture { capture = CGRequestScreenCaptureAccess() }
    var hints: [String] = []
    if !accessibility {
        hints.append("Accessibility is off: System Settings → Privacy & Security → Accessibility, enable Larry Agent (or the terminal running it in development), then restart it.")
    }
    if !capture {
        hints.append("Screen Recording is off (needed for screenshots and OCR): System Settings → Privacy & Security → Screen & System Audio Recording, enable Larry Agent, then retry.")
    }
    return ["accessibility": accessibility, "screen_capture": capture, "hints": hints]
}

private func cgWindows() -> [[String: Any]] {
    (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
}

private func windowPid(_ w: [String: Any]) -> Int? { w[kCGWindowOwnerPID as String] as? Int }
private func windowLayer(_ w: [String: Any]) -> Int { w[kCGWindowLayer as String] as? Int ?? 0 }
private func windowOwner(_ w: [String: Any]) -> String { w[kCGWindowOwnerName as String] as? String ?? "" }

private func windowBounds(_ w: [String: Any]) -> CGRect {
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    return CGRect(
        x: b["X"] as? Double ?? 0,
        y: b["Y"] as? Double ?? 0,
        width: b["Width"] as? Double ?? 0,
        height: b["Height"] as? Double ?? 0
    )
}

private func frontmostPid() -> Int? {
    if let app = NSWorkspace.shared.frontmostApplication { return Int(app.processIdentifier) }
    return cgWindows().first(where: { windowLayer($0) == 0 && windowPid($0) != nil }).flatMap(windowPid)
}

private func systemInfo() -> Object {
    [
        "version": helperVersion,
        "platform": "macos",
        "screens": screens(),
        "permissions": permissions(prompt: false),
        "frontmost_pid": nullable(frontmostPid()),
        "background_input": setWindowLocation != nil,
    ]
}

private var heldButtons: [String] = []

private struct ButtonEvents {
    let down: CGEventType
    let up: CGEventType
    let drag: CGEventType
    let button: CGMouseButton
}

private func buttonEvents(_ name: String) -> ButtonEvents {
    switch name {
    case "right": return ButtonEvents(down: .rightMouseDown, up: .rightMouseUp, drag: .rightMouseDragged, button: .right)
    case "middle": return ButtonEvents(down: .otherMouseDown, up: .otherMouseUp, drag: .otherMouseDragged, button: .center)
    default: return ButtonEvents(down: .leftMouseDown, up: .leftMouseUp, drag: .leftMouseDragged, button: .left)
    }
}

private func eventFlags(_ names: Any?) -> CGEventFlags {
    var flags: CGEventFlags = []
    for name in (names as? [String]) ?? [] {
        switch name {
        case "cmd": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "option": flags.insert(.maskAlternate)
        case "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: break
        }
    }
    return flags
}

private func cursor() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

private var lastSyntheticPointerAt: Date?

private func markSyntheticPointer() {
    lastSyntheticPointerAt = Date()
}

private func postMouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, clickState: Int64, flags: CGEventFlags) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.flags = flags
    markSyntheticPointer()
    event.post(tap: .cghidEventTap)
}

private func inputActivity() -> Object {
    let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .scrollWheel]
    let idle = types
        .map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }
        .min() ?? Double.greatestFiniteMagnitude
    var result: Object = ["pointer_idle_s": idle.isFinite ? idle : 1e9, "cursor": pointObject(cursor())]
    if let at = lastSyntheticPointerAt { result["synthetic_age_s"] = Date().timeIntervalSince(at) }
    return result
}

private typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void

private let setWindowLocation: SetWindowLocation? = {
    guard let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY),
          let symbol = dlsym(handle, "CGEventSetWindowLocation")
    else { return nil }
    return unsafeBitCast(symbol, to: SetWindowLocation.self)
}()

private let windowNumberField = CGEventField(rawValue: 51)!

private let systemSurfaceOwners: Set<String> = [
    "Window Server",
    "Dock",
    "Control Center",
    "SystemUIServer",
    "Notification Center",
    "NotificationCenter",
    "Spotlight",
    "WindowManager",
]

private struct WindowTarget {
    let pid: Int
    let window: CGWindowID
    let bounds: CGRect
    let layer: Int
    let owner: String

    var systemSurface: Bool { systemSurfaceOwners.contains(owner) }
    var appWindow: Bool { !systemSurface && pid != ownPid }
}

private func windowTarget(at point: CGPoint) -> WindowTarget? {
    let overlayLevel = Int(CGWindowLevelForKey(.screenSaverWindow))
    let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    for window in windows {
        let layer = windowLayer(window)
        guard layer >= 0, layer < overlayLevel else { continue }
        guard (window[kCGWindowAlpha as String] as? Double ?? 1) > 0.01 else { continue }
        let bounds = windowBounds(window)
        guard bounds.contains(point), let pid = windowPid(window) else { continue }
        let number = window[kCGWindowNumber as String] as? Int ?? 0
        let target = WindowTarget(pid: pid, window: CGWindowID(max(0, number)), bounds: bounds, layer: layer, owner: windowOwner(window))
        if target.systemSurface, coversDisplay(bounds, at: point), !surfaceClaims(point, pid: pid) { continue }
        return target
    }
    return nil
}

private func coversDisplay(_ bounds: CGRect, at point: CGPoint) -> Bool {
    var display: CGDirectDisplayID = 0
    var count: UInt32 = 0
    guard CGGetDisplaysWithPoint(point, 1, &display, &count) == .success, count > 0 else { return false }
    return bounds.insetBy(dx: -1, dy: -1).contains(CGDisplayBounds(display))
}

private func surfaceClaims(_ point: CGPoint, pid: Int) -> Bool {
    guard pid != ownPid else { return false }
    let app = AXUIElementCreateApplication(pid_t(pid))
    AXUIElementSetMessagingTimeout(app, 0.5)
    var found: AXUIElement?
    return AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &found) == .success && found != nil
}

private func deliverable(_ target: WindowTarget?) -> WindowTarget? {
    guard let target, target.appWindow, setWindowLocation != nil else { return nil }
    return target
}

/// Menus (layer != 0) track the hardware pointer, so a posted click inside one only dismisses it.
private func backgroundTarget(at point: CGPoint) -> WindowTarget? {
    guard let hit = windowTarget(at: point), hit.layer == 0 else { return nil }
    return deliverable(hit)
}

private func backgroundDelivery(_ target: WindowTarget, activated: Bool? = nil) -> Object {
    var delivery: Object = ["mode": "background", "pid": target.pid, "window": Int(target.window), "app": target.owner]
    if let activated { delivery["activated"] = activated }
    return delivery
}

private func route(_ event: CGEvent, at point: CGPoint, to target: WindowTarget) {
    let window = Int64(target.window)
    event.setIntegerValueField(windowNumberField, value: window)
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: window)
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: window)
    setWindowLocation?(event, CGPoint(x: point.x - target.bounds.minX, y: point.y - target.bounds.minY))
    event.postToPid(pid_t(target.pid))
}

private func deliverMouse(
    _ type: CGEventType,
    _ point: CGPoint,
    to target: WindowTarget,
    button: CGMouseButton,
    clickState: Int64,
    flags: CGEventFlags
) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.flags = flags
    route(event, at: point, to: target)
}

private func matchingAXWindow(_ app: AXUIElement, _ bounds: CGRect) -> AXUIElement? {
    let windows = (axAttribute(app, "AXWindows") as? [AXUIElement]) ?? []
    return windows.first { window in
        guard let frame = axFrame(window) else { return false }
        return abs(frame.minX - bounds.minX) < 2 && abs(frame.minY - bounds.minY) < 2
            && abs(frame.width - bounds.width) < 2 && abs(frame.height - bounds.height) < 2
    }
}

private func focusForClick(_ target: WindowTarget) -> Bool {
    guard target.layer == 0 else { return false }
    let app = applicationElement(target.pid)
    var changed = false
    if (axAttribute(app, "AXFrontmost") as? Bool) != true {
        changed = AXUIElementSetAttributeValue(app, "AXFrontmost" as CFString, kCFBooleanTrue) == .success
    }
    if let window = matchingAXWindow(app, target.bounds), (axAttribute(window, "AXMain") as? Bool) != true {
        AXUIElementPerformAction(window, "AXRaise" as CFString)
        AXUIElementSetAttributeValue(window, "AXMain" as CFString, kCFBooleanTrue)
        changed = true
    }
    guard changed else { return false }
    for _ in 0..<12 {
        if (axAttribute(app, "AXFrontmost") as? Bool) == true { break }
        usleep(25_000)
    }
    usleep(80_000)
    return true
}

private func wantsBorrow(_ a: Args) -> Bool {
    str(a, "delivery") == "borrow"
}

private struct HeldPress {
    let target: WindowTarget
    let button: String
    var point: CGPoint
}

private var heldPress: HeldPress?

private var borrowedCursor: CGPoint?
private var borrowingPointer = false
private var decoupledPointer = false

private func beginPointerBorrow(decouple: Bool = true) {
    guard !borrowingPointer else { return }
    markSyntheticPointer()
    borrowedCursor = cursor()
    CGDisplayHideCursor(CGMainDisplayID())
    if decouple {
        CGAssociateMouseAndMouseCursorPosition(0)
        decoupledPointer = true
    }
    borrowingPointer = true
}

@discardableResult
private func endPointerBorrow(from point: CGPoint) -> Bool {
    guard borrowingPointer else { return false }
    markSyntheticPointer()
    let now = cursor()
    var restored = false
    if let saved = borrowedCursor {
        // Skip the warp when the user grabbed the pointer while we borrowed it.
        if hypot(now.x - point.x, now.y - point.y) < 1.5 {
            CGWarpMouseCursorPosition(saved)
            let after = cursor()
            restored = hypot(after.x - saved.x, after.y - saved.y) < 1.5
        }
    }
    if decoupledPointer {
        CGAssociateMouseAndMouseCursorPosition(1)
        decoupledPointer = false
    }
    CGDisplayShowCursor(CGMainDisplayID())
    borrowedCursor = nil
    borrowingPointer = false
    return restored
}

private func borrowedDelivery(_ restored: Bool) -> Object {
    ["mode": "borrowed", "cursor_restored": restored]
}

private func hoverAlong(points: [CGPoint], intervalMs: Int) -> WindowTarget? {
    var last: WindowTarget?
    for (index, point) in points.enumerated() {
        if let press = heldPress {
            let events = buttonEvents(press.button)
            deliverMouse(events.drag, point, to: press.target, button: events.button, clickState: 1, flags: [])
            heldPress?.point = point
            last = press.target
        } else {
            if last.map({ !$0.bounds.contains(point) }) ?? true {
                last = backgroundTarget(at: point)
            }
            if let target = last {
                deliverMouse(.mouseMoved, point, to: target, button: .left, clickState: 0, flags: [])
            }
        }
        if index < points.count - 1 && intervalMs > 0 {
            usleep(useconds_t(intervalMs * 1000))
        }
    }
    return last
}

private func axActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

private func axParent(_ element: AXUIElement) -> AXUIElement? {
    guard let parent = axAttribute(element, "AXParent"), CFGetTypeID(parent) == AXUIElementGetTypeID() else { return nil }
    return (parent as! AXUIElement)
}

private func axNumber(_ element: AXUIElement, _ name: String) -> Double? {
    (axAttribute(element, name) as? NSNumber)?.doubleValue
}

private func elementAt(_ point: CGPoint, ownedBy pid: Int) -> AXUIElement? {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 1.0)
    var found: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &found) == .success, let element = found else {
        return nil
    }
    var owner: pid_t = 0
    guard AXUIElementGetPid(element, &owner) == .success, Int(owner) == pid else { return nil }
    AXUIElementSetMessagingTimeout(element, 1.0)
    return element
}

private let menuControlRoles: Set<String> = ["AXPopUpButton", "AXMenuButton"]

private func pressSurface(
    at point: CGPoint,
    target: WindowTarget,
    button: String,
    menuControlsOnly: Bool = false
) -> Object? {
    let action: String
    switch button {
    case "left": action = "AXPress"
    case "right": action = "AXShowMenu"
    default: return nil
    }
    let owner = target.owner == "Window Server" ? frontmostPid() : target.pid
    guard let owner, owner != ownPid, var element = elementAt(point, ownedBy: owner) else { return nil }
    for _ in 0..<4 {
        let role = axRole(element)
        let eligible = !menuControlsOnly || role.map { menuControlRoles.contains($0) } ?? false
        if eligible, axActions(element).contains(action) {
            let result = AXUIElementPerformAction(element, action as CFString)
            guard result == .success || result == .cannotComplete else { return nil }
            return [
                "mode": "accessibility",
                "action": action,
                "role": role ?? "",
                "name": axName(element, role: role) ?? "",
                "pid": owner,
            ]
        }
        guard let parent = axParent(element) else { break }
        element = parent
    }
    return nil
}

private func stableNumber(_ element: AXUIElement, changedFrom start: Double, timeout: Double) -> Double? {
    let deadline = Date().addingTimeInterval(timeout)
    var last = axNumber(element, "AXValue")
    var sawChange = last.map { $0 != start } ?? false
    while Date() < deadline {
        usleep(40_000)
        let now = axNumber(element, "AXValue")
        if let now, now != start { sawChange = true }
        if sawChange, now == last { return now }
        last = now
    }
    return last
}

private func sliderAncestor(_ element: AXUIElement) -> AXUIElement? {
    var current: AXUIElement? = element
    for _ in 0..<3 {
        guard let node = current else { return nil }
        if axRole(node) == "AXSlider" { return node }
        current = axParent(node)
    }
    return nil
}

private func setSlider(_ slider: AXUIElement, toward end: CGPoint, pid: Int) -> Object? {
    guard let frame = axFrame(slider), frame.width > 0, frame.height > 0,
          let minimum = axNumber(slider, "AXMinValue"),
          let maximum = axNumber(slider, "AXMaxValue"),
          maximum > minimum,
          let before = axNumber(slider, "AXValue")
    else { return nil }
    let orientation = axAttribute(slider, "AXOrientation") as? String
    let vertical = orientation.map { $0 == "AXVerticalOrientation" } ?? (frame.height > frame.width)
    let fraction = vertical ? 1 - (end.y - frame.minY) / frame.height : (end.x - frame.minX) / frame.width
    let wanted = minimum + Double(max(0, min(1, fraction))) * (maximum - minimum)
    let tolerance = (maximum - minimum) * 0.02
    let result: (Double) -> Object = { value in
        ["mode": "accessibility", "control": "slider", "value": value, "target_value": wanted, "pid": pid]
    }
    if abs(before - wanted) <= tolerance { return result(before) }

    var settable: DarwinBoolean = false
    if AXUIElementIsAttributeSettable(slider, "AXValue" as CFString, &settable) == .success, settable.boolValue,
       AXUIElementSetAttributeValue(slider, "AXValue" as CFString, NSNumber(value: wanted)) == .success,
       let now = stableNumber(slider, changedFrom: before, timeout: 0.2), abs(now - wanted) <= tolerance {
        return result(now)
    }

    var value = axNumber(slider, "AXValue") ?? before
    let actions = axActions(slider)
    var moved = false
    for _ in 0..<3 {
        let remaining = wanted - value
        if abs(remaining) <= tolerance { break }
        let action = remaining > 0 ? "AXIncrement" : "AXDecrement"
        guard actions.contains(action) else { break }
        AXUIElementPerformAction(slider, action as CFString)
        guard let stepped = stableNumber(slider, changedFrom: value, timeout: 0.3), stepped != value else { break }
        moved = true
        let step = abs(stepped - value)
        value = stepped
        let count = min(400, Int((abs(wanted - value) / step).rounded()))
        for _ in 0..<count { AXUIElementPerformAction(slider, action as CFString) }
        if count > 0 { value = stableNumber(slider, changedFrom: value, timeout: 0.4) ?? value }
    }
    return moved ? result(value) : nil
}

private func setAXPoint(_ element: AXUIElement, _ name: String, _ point: CGPoint) -> Bool {
    var value = point
    guard let ax = AXValueCreate(.cgPoint, &value) else { return false }
    return AXUIElementSetAttributeValue(element, name as CFString, ax) == .success
}

private func setAXSize(_ element: AXUIElement, _ size: CGSize) -> Bool {
    var value = size
    guard let ax = AXValueCreate(.cgSize, &value) else { return false }
    return AXUIElementSetAttributeValue(element, "AXSize" as CFString, ax) == .success
}

private func moveOrResizeWindow(_ element: AXUIElement, from start: CGPoint, to end: CGPoint, pid: Int) -> Object? {
    let role = axRole(element)
    let window: AXUIElement
    if role == "AXWindow" {
        window = element
    } else if let owner = axAttribute(element, "AXWindow"), CFGetTypeID(owner) == AXUIElementGetTypeID() {
        window = owner as! AXUIElement
    } else {
        return nil
    }
    guard let frame = axFrame(window), frame.contains(start) else { return nil }
    let dx = end.x - start.x
    let dy = end.y - start.y
    let edge: CGFloat = 6
    let left = role == "AXWindow" && start.x - frame.minX <= edge
    let right = role == "AXWindow" && frame.maxX - start.x <= edge
    let top = role == "AXWindow" && start.y - frame.minY <= edge
    let bottom = role == "AXWindow" && frame.maxY - start.y <= edge

    if left || right || top || bottom {
        var next = frame
        if left { next.origin.x += dx; next.size.width -= dx }
        if right { next.size.width += dx }
        if top { next.origin.y += dy; next.size.height -= dy }
        if bottom { next.size.height += dy }
        guard next.width >= 40, next.height >= 40 else { return nil }
        if left || top { _ = setAXPoint(window, "AXPosition", next.origin) }
        guard setAXSize(window, next.size), let now = axFrame(window), now != frame else { return nil }
        return ["mode": "accessibility", "control": "window_resize", "frame": rectObject(now), "pid": pid]
    }

    let titleBand: CGFloat = role == "AXWindow" ? 28 : 52
    let parentRole = axParent(element).flatMap(axRole)
    let dragsWindow = role == "AXWindow" || role == "AXToolbar" || (role == "AXStaticText" && parentRole == "AXWindow")
    guard dragsWindow, start.y - frame.minY <= titleBand else { return nil }
    let origin = CGPoint(x: frame.minX + dx, y: frame.minY + dy)
    guard setAXPoint(window, "AXPosition", origin), let now = axFrame(window), now.origin != frame.origin else { return nil }
    return ["mode": "accessibility", "control": "window_move", "frame": rectObject(now), "pid": pid]
}

private func dragByAccessibility(from start: CGPoint, to end: CGPoint) -> Object? {
    guard let target = windowTarget(at: start), target.appWindow, target.layer == 0,
          let element = elementAt(start, ownedBy: target.pid)
    else { return nil }
    if let slider = sliderAncestor(element) { return setSlider(slider, toward: end, pid: target.pid) }
    return moveOrResizeWindow(element, from: start, to: end, pid: target.pid)
}

private func pointList(_ a: Args, _ key: String) -> [CGPoint] {
    (a[key] as? [Any] ?? []).compactMap { item in
        guard let entry = item as? Args, let x = num(entry, "x"), let y = num(entry, "y") else { return nil }
        return CGPoint(x: x, y: y)
    }
}

private func inputHover(_ a: Args) throws -> Object {
    try requireAccessibility()
    let points = pointList(a, "points")
    guard !points.isEmpty else { throw fail("invalid_arguments", "points is required") }
    let before = cursor()
    let target = hoverAlong(points: points, intervalMs: Int(num(a, "interval_ms") ?? 0))
    let after = cursor()
    return [
        "hovered": points.count,
        "target_pid": target.map { Int($0.pid) } ?? NSNull(),
        "target_window": target.map { Int($0.window) } ?? NSNull(),
        "pointer_moved": hypot(after.x - before.x, after.y - before.y) > 0.5,
    ]
}

private func inputClickAt(_ a: Args) throws -> Object {
    try requireAccessibility()
    let point = CGPoint(x: num(a, "x") ?? 0, y: num(a, "y") ?? 0)
    let name = str(a, "button") ?? "left"
    let events = buttonEvents(name)
    let clicks = max(1, Int(num(a, "clicks") ?? 1))
    let holdMs = max(0, num(a, "hold_ms") ?? 50)
    let gapMs = max(0, num(a, "gap_ms") ?? 30)
    let flags = eventFlags(a["modifiers"])
    if !wantsBorrow(a), heldPress == nil, !borrowingPointer {
        let hit = windowTarget(at: point)
        if let hit, hit.layer == 0, !hit.systemSurface, clicks == 1, flags.isEmpty,
           let pressed = pressSurface(at: point, target: hit, button: name, menuControlsOnly: true) {
            return ["clicked": pointObject(point), "clicks": 1, "delivery": pressed]
        }
        if let hit, hit.layer == 0, let target = deliverable(hit) {
            let activated = focusForClick(target)
            deliverMouse(.mouseMoved, point, to: target, button: events.button, clickState: 0, flags: flags)
            usleep(8_000)
            for index in 1...clicks {
                deliverMouse(events.down, point, to: target, button: events.button, clickState: Int64(index), flags: flags)
                usleep(useconds_t(holdMs * 1000))
                deliverMouse(events.up, point, to: target, button: events.button, clickState: Int64(index), flags: flags)
                if index < clicks { usleep(useconds_t(gapMs * 1000)) }
            }
            return ["clicked": pointObject(point), "clicks": clicks, "delivery": backgroundDelivery(target, activated: activated)]
        }
        if let hit, hit.systemSurface, clicks == 1, flags.isEmpty, let pressed = pressSurface(at: point, target: hit, button: name) {
            return ["clicked": pointObject(point), "clicks": 1, "delivery": pressed]
        }
    }
    beginPointerBorrow()
    CGWarpMouseCursorPosition(point)
    usleep(8_000)
    for index in 1...clicks {
        postMouse(events.down, point, events.button, clickState: Int64(index), flags: flags)
        usleep(useconds_t(holdMs * 1000))
        postMouse(events.up, point, events.button, clickState: Int64(index), flags: flags)
        if index < clicks { usleep(useconds_t(gapMs * 1000)) }
    }
    let restored = endPointerBorrow(from: point)
    return [
        "clicked": pointObject(point),
        "clicks": clicks,
        "delivery": borrowedDelivery(restored),
    ]
}

private func inputDragPath(_ a: Args) throws -> Object {
    try requireAccessibility()
    let points = pointList(a, "points")
    guard points.count >= 2 else { throw fail("invalid_arguments", "points needs at least a start and an end") }
    let name = str(a, "button") ?? "left"
    let events = buttonEvents(name)
    let intervalMs = max(1, Int(num(a, "interval_ms") ?? 8))
    let settleMs = max(0, num(a, "settle_ms") ?? 60)
    let start = points[0]
    let end = points[points.count - 1]
    let dragged: Object = ["from": pointObject(start), "to": pointObject(end), "frames": points.count]
    if !wantsBorrow(a), heldPress == nil, !borrowingPointer {
        if name == "left", let adjusted = dragByAccessibility(from: start, to: end) {
            return ["dragged": dragged, "delivery": adjusted]
        }
        if let target = backgroundTarget(at: start) {
            let activated = focusForClick(target)
            deliverMouse(.mouseMoved, start, to: target, button: events.button, clickState: 0, flags: [])
            usleep(8_000)
            deliverMouse(events.down, start, to: target, button: events.button, clickState: 1, flags: [])
            usleep(useconds_t(settleMs * 1000))
            for point in points.dropFirst() {
                deliverMouse(events.drag, point, to: target, button: events.button, clickState: 1, flags: [])
                usleep(useconds_t(intervalMs * 1000))
            }
            usleep(useconds_t(settleMs * 1000))
            deliverMouse(events.up, end, to: target, button: events.button, clickState: 1, flags: [])
            return ["dragged": dragged, "delivery": backgroundDelivery(target, activated: activated)]
        }
    }
    beginPointerBorrow()
    CGWarpMouseCursorPosition(start)
    usleep(8_000)
    postMouse(events.down, start, events.button, clickState: 1, flags: [])
    usleep(useconds_t(settleMs * 1000))
    for point in points.dropFirst() {
        postMouse(events.drag, point, events.button, clickState: 1, flags: [])
        usleep(useconds_t(intervalMs * 1000))
    }
    usleep(useconds_t(settleMs * 1000))
    postMouse(events.up, end, events.button, clickState: 1, flags: [])
    let restored = endPointerBorrow(from: end)
    return ["dragged": dragged, "delivery": borrowedDelivery(restored)]
}

private func inputScrollAt(_ a: Args) throws -> Object {
    try requireAccessibility()
    let point = CGPoint(x: num(a, "x") ?? cursor().x, y: num(a, "y") ?? cursor().y)
    let unit: CGScrollEventUnit = str(a, "unit") == "pixel" ? .pixel : .line
    let dy = Int32((num(a, "dy") ?? 0).rounded())
    let dx = Int32((num(a, "dx") ?? 0).rounded())
    let scrolled: Object = ["delta_x": Int(dx), "delta_y": Int(dy)]
    if !wantsBorrow(a), heldPress == nil, !borrowingPointer, let target = backgroundTarget(at: point),
       let event = CGEvent(scrollWheelEvent2Source: nil, units: unit, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
        event.location = point
        route(event, at: point, to: target)
        return ["scrolled": scrolled, "at": pointObject(point), "delivery": backgroundDelivery(target)]
    }
    beginPointerBorrow()
    CGWarpMouseCursorPosition(point)
    usleep(10_000)
    markSyntheticPointer()
    CGEvent(scrollWheelEvent2Source: nil, units: unit, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?.post(tap: .cghidEventTap)
    usleep(10_000)
    let restored = endPointerBorrow(from: point)
    return ["scrolled": scrolled, "at": pointObject(point), "delivery": borrowedDelivery(restored)]
}

private func inputButtonAt(_ a: Args) throws -> Object {
    try requireAccessibility()
    let name = str(a, "button") ?? "left"
    let events = buttonEvents(name)
    let down = flag(a, "down", true)
    let flags = eventFlags(a["modifiers"])
    if down {
        let point = CGPoint(x: num(a, "x") ?? cursor().x, y: num(a, "y") ?? cursor().y)
        if !wantsBorrow(a), heldPress == nil, !borrowingPointer, let target = backgroundTarget(at: point) {
            let activated = focusForClick(target)
            deliverMouse(.mouseMoved, point, to: target, button: events.button, clickState: 0, flags: flags)
            usleep(8_000)
            deliverMouse(events.down, point, to: target, button: events.button, clickState: 1, flags: flags)
            heldPress = HeldPress(target: target, button: name, point: point)
            heldButtons.removeAll { $0 == name }
            heldButtons.append(name)
            return [
                "held": pointObject(point),
                "button": name,
                "held_buttons": heldButtons,
                "delivery": backgroundDelivery(target, activated: activated),
            ]
        }
        beginPointerBorrow(decouple: false)
        CGWarpMouseCursorPosition(point)
        usleep(8_000)
        postMouse(events.down, point, events.button, clickState: 1, flags: flags)
        heldButtons.removeAll { $0 == name }
        heldButtons.append(name)
        return ["held": pointObject(point), "button": name, "held_buttons": heldButtons, "delivery": ["mode": "borrowed"]]
    }
    if let press = heldPress, press.button == name {
        deliverMouse(events.up, press.point, to: press.target, button: events.button, clickState: 1, flags: flags)
        heldPress = nil
        heldButtons.removeAll { $0 == name }
        return [
            "released": pointObject(press.point),
            "button": name,
            "held_buttons": heldButtons,
            "delivery": backgroundDelivery(press.target),
        ]
    }
    let point = cursor()
    postMouse(events.up, point, events.button, clickState: 1, flags: flags)
    heldButtons.removeAll { $0 == name }
    let restored = endPointerBorrow(from: point)
    return ["released": pointObject(point), "button": name, "held_buttons": heldButtons, "delivery": borrowedDelivery(restored)]
}

private func requireAccessibility() throws {
    if !AXIsProcessTrusted() {
        throw fail("permission_required", "Accessibility permission is required to send input and read UI elements. Enable Larry Agent in System Settings → Privacy & Security → Accessibility (computer_system request_permissions shows the prompt), then retry.")
    }
}

private func runSequence(_ a: Args) throws -> Object {
    try requireAccessibility()
    guard let events = a["events"] as? [Any] else { throw fail("invalid_arguments", "events is required") }
    for item in events {
        guard let e = item as? Args else { continue }
        switch str(e, "t") ?? "" {
        case "move":
            let point = CGPoint(x: num(e, "x") ?? 0, y: num(e, "y") ?? 0)
            if let held = heldButtons.last {
                let b = buttonEvents(held)
                postMouse(b.drag, point, b.button, clickState: 1, flags: [])
            } else {
                postMouse(.mouseMoved, point, .left, clickState: 0, flags: [])
            }
        case "button":
            let name = str(e, "button") ?? "left"
            let down = flag(e, "down", true)
            let b = buttonEvents(name)
            let point: CGPoint
            if let x = num(e, "x"), let y = num(e, "y") {
                point = CGPoint(x: x, y: y)
            } else {
                point = cursor()
            }
            let clickState = Int64(num(e, "click_state") ?? 1)
            postMouse(down ? b.down : b.up, point, b.button, clickState: clickState, flags: eventFlags(e["modifiers"]))
            heldButtons.removeAll { $0 == name }
            if down { heldButtons.append(name) }
        case "scroll":
            let unit: CGScrollEventUnit = str(e, "unit") == "pixel" ? .pixel : .line
            let dy = Int32((num(e, "dy") ?? 0).rounded())
            let dx = Int32((num(e, "dx") ?? 0).rounded())
            markSyntheticPointer()
            CGEvent(scrollWheelEvent2Source: nil, units: unit, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?.post(tap: .cghidEventTap)
        case "vk":
            let code = CGKeyCode(num(e, "code") ?? 0)
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: flag(e, "down", true)) else { break }
            event.flags = eventFlags(e["modifiers"])
            event.post(tap: .cghidEventTap)
        case "char":
            let units = Array((str(e, "text") ?? "").utf16)
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: flag(e, "down", true)) else { break }
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            event.flags = eventFlags(e["modifiers"])
            event.post(tap: .cghidEventTap)
        case "sleep":
            let ms = max(0, num(e, "ms") ?? 0)
            if ms > 0 { usleep(UInt32(ms * 1000)) }
        case let other:
            throw fail("invalid_arguments", "Unknown input event type: \(other)")
        }
    }
    var result = pointObject(cursor())
    result["held_buttons"] = heldButtons
    return result
}

private func axAttribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

private func axText(_ element: AXUIElement, _ name: String) -> String? {
    guard let text = axAttribute(element, name) as? String else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

private func axRole(_ element: AXUIElement) -> String? {
    axAttribute(element, "AXRole") as? String
}

private func axName(_ element: AXUIElement, role: String?) -> String? {
    axText(element, "AXTitle")
        ?? axText(element, "AXDescription")
        ?? (role == "AXStaticText" ? axText(element, "AXValue") : nil)
        ?? axText(element, "AXIdentifier")
}

private func axFrame(_ element: AXUIElement) -> CGRect? {
    guard let position = axAttribute(element, "AXPosition"),
          let size = axAttribute(element, "AXSize"),
          CFGetTypeID(position) == AXValueGetTypeID(),
          CFGetTypeID(size) == AXValueGetTypeID()
    else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &extent)
    else { return nil }
    return CGRect(origin: point, size: extent)
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    (axAttribute(element, "AXChildren") as? [AXUIElement]) ?? []
}

private func isPasswordField(_ element: AXUIElement, role: String?) -> Bool {
    role == "AXTextField" && axText(element, "AXSubrole") == "AXSecureTextField"
}

private func hasPasswordText(_ element: AXUIElement) -> Bool {
    // Only positive accessibility metadata counts. Browsers can show a preview
    // before exposing a value, so zero or an unavailable attribute is inconclusive.
    if let count = axNumber(element, "AXNumberOfCharacters"), count > 0 { return true }
    guard let selection = axAttribute(element, "AXSelectedTextRange"),
          CFGetTypeID(selection) == AXValueGetTypeID() else { return false }
    var range = CFRange()
    guard AXValueGetValue(selection as! AXValue, .cfRange, &range),
          range.location >= 0, range.location != NSNotFound else { return false }
    return range.location > 0 || range.length > 0
}

private func describe(_ element: AXUIElement, role: String?, name: String?, frame: CGRect?) -> Object {
    var object: Object = ["role": role ?? "", "name": name ?? "", "frame": NSNull()]
    if let frame {
        object["frame"] = rectObject(frame)
        object["center"] = pointObject(CGPoint(x: frame.midX, y: frame.midY))
    }
    if let identifier = axText(element, "AXIdentifier") { object["automation_id"] = identifier }
    if let enabled = axAttribute(element, "AXEnabled") as? Bool, !enabled { object["enabled"] = false }
    if isPasswordField(element, role: role) {
        object["protected"] = true
        if hasPasswordText(element) { object["password_present"] = true }
    }
    return object
}

private func matchName(_ query: String?, _ candidate: String?) -> Bool {
    let q = (query ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if q.isEmpty { return true }
    let c = (candidate ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return c == q || c.hasPrefix(q) || c.contains(q)
}

private struct WalkState {
    var visited = 0
    var truncated = false
    var results: [Object] = []
}

private func walk(_ root: AXUIElement, role: String?, name: String?, deadline: Date, maxDepth: Int, maxNodes: Int, state: inout WalkState) {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var head = 0
    while head < queue.count {
        if state.visited >= maxNodes || Date() > deadline {
            state.truncated = true
            return
        }
        let (element, depth) = queue[head]
        head += 1
        state.visited += 1
        if let elementRole = axRole(element),
           role == nil || elementRole.caseInsensitiveCompare(role!) == .orderedSame {
            let elementName = axName(element, role: elementRole)
            if name == nil || matchName(name, elementName), let frame = axFrame(element) {
                state.results.append(describe(element, role: elementRole, name: elementName, frame: frame))
            }
        }
        if depth < maxDepth {
            for child in axChildren(element) { queue.append((child, depth + 1)) }
        }
    }
}

private func dedupe(_ items: [Object]) -> [Object] {
    var seen = Set<String>()
    return items.filter { item in
        let center = item["center"] as? Object
        let key = "\(item["role"] ?? "")|\(item["name"] ?? "")|\(center?["x"] ?? "")|\(center?["y"] ?? "")"
        return seen.insert(key).inserted
    }
}

private func applicationElement(_ pid: Int) -> AXUIElement {
    let element = AXUIElementCreateApplication(pid_t(pid))
    AXUIElementSetMessagingTimeout(element, 1.0)
    return element
}

private func appObject(pid: Int, name: String, bundleId: String) -> Object {
    ["pid": pid, "name": name, "bundle_id": bundleId]
}

private func liveApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { !$0.isTerminated }
}

private func findApp(_ target: Any?) -> Object? {
    let apps = liveApps()
    var pidTarget: Int?
    if let number = target as? NSNumber {
        pidTarget = number.intValue
    } else if let text = target as? String, let value = Int(text.trimmingCharacters(in: .whitespaces)) {
        pidTarget = value
    }
    if let pid = pidTarget {
        if let app = apps.first(where: { Int($0.processIdentifier) == pid }) {
            return appObject(pid: pid, name: app.localizedName ?? "", bundleId: app.bundleIdentifier ?? "")
        }
        if let window = cgWindows().first(where: { windowPid($0) == pid }) {
            return appObject(pid: pid, name: windowOwner(window), bundleId: "")
        }
        return nil
    }
    guard let raw = target as? String else { return nil }
    let wanted = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if wanted.isEmpty { return nil }
    let info: (NSRunningApplication) -> Object = {
        appObject(pid: Int($0.processIdentifier), name: $0.localizedName ?? "", bundleId: $0.bundleIdentifier ?? "")
    }
    if let app = apps.first(where: { ($0.bundleIdentifier ?? "").lowercased() == wanted }) { return info(app) }
    if let app = apps.first(where: { ($0.localizedName ?? "").lowercased() == wanted }) { return info(app) }
    if let app = apps.first(where: { ($0.localizedName ?? "").lowercased().contains(wanted) }) { return info(app) }
    for window in cgWindows() where windowLayer(window) == 0 {
        if let pid = windowPid(window), windowOwner(window).lowercased().contains(wanted) {
            return appObject(pid: pid, name: windowOwner(window), bundleId: "")
        }
    }
    return nil
}

private func appWindows(_ pid: Int) -> [Object] {
    let front = frontmostPid()
    return cgWindows().compactMap { window in
        guard windowPid(window) == pid, windowLayer(window) == 0 else { return nil }
        var object = rectObject(windowBounds(window))
        object["title"] = window[kCGWindowName as String] as? String ?? ""
        object["active"] = front == pid
        return object
    }
}

private struct PasswordField {
    let element: AXUIElement
    let window: AXUIElement
    let origin: String?
    let loginOrigin: String?
    let pid: pid_t
    let launchDate: Date?
    let expires: Date
}

private let passwordFieldLock = NSLock()
private var passwordFields: [String: PasswordField] = [:]

private func removePasswordField(_ token: String) -> PasswordField? {
    passwordFieldLock.lock()
    defer { passwordFieldLock.unlock() }
    return passwordFields.removeValue(forKey: token)
}

private func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    guard let value = axAttribute(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

private func batchDesktopState(_ args: Args) throws -> Object {
    try requireAccessibility()
    let pid = NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) }
    let current = pid.flatMap { pid in
        cgWindows().first { windowPid($0) == pid && windowLayer($0) == 0 && !windowBounds($0).isEmpty }
    }
    var result: Object = ["pid": nullable(pid), "window": NSNull(), "modal": false]
    if let current, let id = current[kCGWindowNumber as String] as? NSNumber {
        result["window"] = ["id": id.stringValue, "title": current[kCGWindowName as String] as? String ?? "",
                            "frame": rectObject(windowBounds(current))]
    }
    if let x = num(args, "x"), let y = num(args, "y") {
        result["hit_window_id"] = windowTarget(at: CGPoint(x: x, y: y)).map { String($0.window) } ?? ""
    }
    guard let pid, pid == Int(num(args, "pid") ?? 0), pid != ownPid else { return result }
    let app = applicationElement(pid)
    guard let window = axElement(app, "AXFocusedWindow") else {
        // An input batch needs a verifiable focused window.
        result["window"] = NSNull()
        return result
    }
    if var details = result["window"] as? Object, let title = axText(window, "AXTitle") {
        details["title"] = title
        result["window"] = details
    }
    result["modal"] = (axAttribute(window, "AXModal") as? Bool) == true ||
        axRole(window) == "AXSheet" || axSubroleIsDialog(window) ||
        axChildren(window).contains { axRole($0) == "AXSheet" }
    if let focus = axElement(app, "AXFocusedUIElement"), let role = axRole(focus) {
        var ancestor: AXUIElement? = focus
        for _ in 0..<32 {
            guard let node = ancestor, !CFEqual(node, window) else { break }
            if axRole(node) == "AXSheet" || axSubroleIsDialog(node) {
                result["modal"] = true
                break
            }
            ancestor = axElement(node, "AXParent")
        }
        let protected = axText(focus, "AXSubrole") == "AXSecureTextField"
        var field: Object = ["role": role, "name": axName(focus, role: nil) ?? "", "protected": protected]
        if protected, hasPasswordText(focus) { field["password_present"] = true }
        if let identifier = axText(focus, "AXIdentifier") { field["automation_id"] = identifier }
        result["focused"] = field
    }
    return result
}

private func axSubroleIsDialog(_ element: AXUIElement) -> Bool {
    let subrole = axText(element, "AXSubrole")
    return subrole == "AXDialog" || subrole == "AXSystemDialog" ||
        subrole == "AXApplicationDialog" || subrole == "AXApplicationAlertDialog"
}

private struct PasswordFieldContext {
    let window: AXUIElement
    let origin: String?
    let loginScope: AXUIElement?
}

private func passwordFieldContext(_ field: AXUIElement) -> PasswordFieldContext? {
    guard isPasswordField(field, role: axRole(field)) else { return nil }
    let window = axElement(field, "AXWindow")

    var origin: String?
    var scope: AXUIElement?
    var form: AXUIElement?
    var sameOrigin = true
    var node = axElement(field, "AXParent")
    for _ in 0..<64 {
        guard let ancestor = node else { return nil }
        let role = axRole(ancestor)
        if window.map({ CFEqual(ancestor, $0) }) ?? (role == "AXWindow") {
            return PasswordFieldContext(window: ancestor, origin: origin,
                                        loginScope: sameOrigin ? scope : nil)
        }
        if origin == nil, form == nil, role == "AXForm" || axText(ancestor, "AXSubrole") == "AXLandmarkForm" {
            form = ancestor
        }
        if role == "AXWebArea" {
            let address = axAttribute(ancestor, "AXURL")
            let url = (address as? URL) ?? (address as? String).flatMap(URL.init(string:))
            guard let url, let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
                  let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return nil }
            var components = URLComponents()
            components.scheme = scheme
            components.host = host.lowercased()
            components.port = url.port == (scheme == "https" ? 443 : 80) ? nil : url.port
            guard let verifiedOrigin = components.string else { return nil }
            if let origin {
                sameOrigin = sameOrigin && origin == verifiedOrigin
            } else {
                origin = verifiedOrigin
                if scheme == "https" { scope = form ?? ancestor }
            }
        }
        node = axElement(ancestor, "AXParent")
    }
    return nil
}

private func canFillPasswordField(_ field: AXUIElement) -> Bool {
    guard (axAttribute(field, "AXEnabled") as? Bool) != false else { return false }
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(field, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
}

private func isTrustedLoginBrowser(_ app: NSRunningApplication) -> Bool {
    let requirementText: String
    switch app.bundleIdentifier {
    case "com.apple.Safari":
        requirementText = "identifier \"com.apple.Safari\" and anchor apple"
    case "com.google.Chrome":
        requirementText = "identifier \"com.google.Chrome\" and anchor apple generic and certificate leaf[subject.OU] = \"EQHXZ8M8AV\""
    default:
        return false
    }
    var requirement: SecRequirement?
    var code: SecCode?
    let attributes = [kSecGuestAttributePid as String: app.processIdentifier] as CFDictionary
    guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess,
          let requirement,
          SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
          let code else { return false }
    return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
}

private struct WebLoginField {
    let origin: String
    let accountField: AXUIElement?
    let account: String?
}

private func webLoginField(_ password: AXUIElement, context: PasswordFieldContext) -> WebLoginField? {
    guard let scope = context.loginScope, let origin = context.origin else { return nil }
    for attribute in ["AXDOMIdentifier", "AXTitle", "AXDescription", "AXValueAutofillType"] {
        let value = axText(password, attribute) ?? ""
        let name = String(value.lowercased().filter { $0.isLetter || $0.isNumber })
        if ["newpassword", "confirmpassword", "repeatpassword", "onetimecode", "verificationcode", "passcode"].contains(where: name.contains) ||
            name == "pin" || name == "otp" { return nil }
    }
    var nodes = Array(axChildren(scope).reversed())
    var accountCandidates: [AXUIElement] = []
    var foundPassword = false
    let deadline = Date().addingTimeInterval(0.6)
    for _ in 0..<240 {
        guard let node = nodes.popLast() else {
            guard foundPassword else { return nil }
            let field = accountCandidates.count == 1 ? accountCandidates.first : nil
            let value = field.flatMap { axAttribute($0, "AXValue") as? String }
            return WebLoginField(origin: origin, accountField: value == nil ? nil : field, account: value)
        }
        guard Date() < deadline else { return nil }
        let role = axRole(node)
        if role == "AXWebArea" { continue }
        if role == "AXTextField" {
            if axText(node, "AXSubrole") == "AXSecureTextField" {
                guard !foundPassword, CFEqual(node, password) else { return nil }
                foundPassword = true
            } else if !foundPassword, isAccountField(node) {
                accountCandidates.append(node)
            }
        }
        nodes.append(contentsOf: axChildren(node).reversed())
    }
    return nil
}

private func isAccountField(_ field: AXUIElement) -> Bool {
    let identifiers = ["username", "useremail", "email", "emailaddress", "login", "loginfmt",
                       "loginusername", "loginemail", "identifierid", "account", "accountname"]
    let labels = ["username", "email", "emailaddress", "emailorusername", "usernameoremail",
                  "accountname", "yourusername", "youremail", "youremailaddress"]
    for attribute in ["AXDOMIdentifier", "AXTitle", "AXDescription", "AXPlaceholderValue"] {
        guard let value = axText(field, attribute) else { continue }
        let normalized = String(value.lowercased().filter { $0.isLetter || $0.isNumber })
        if (attribute == "AXDOMIdentifier" ? identifiers : labels).contains(normalized) { return true }
    }
    return false
}

private func preparePasswordField(_ args: Args) throws -> Object {
    try requireAccessibility()
    let pid = Int(num(args, "pid") ?? 0)
    try rejectOwnApp(pid, "ui.prepare_password")
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else { return [:] }
    var point: CGPoint?
    if let x = num(args, "x"), let y = num(args, "y"), x.isFinite, y.isFinite {
        point = CGPoint(x: x, y: y)
    }
    let focused = axElement(applicationElement(pid), "AXFocusedUIElement")
    var candidates: [AXUIElement] = []
    if let focused { candidates.append(focused) }
    if let point, let hit = elementAt(point, ownedBy: pid) {
        candidates.append(hit)
        if let parent = axParent(hit) { candidates.append(parent) }
    }
    let signInFailed = flag(args, "sign_in_failed", false)
    for field in candidates {
        var owner: pid_t = 0
        guard AXUIElementGetPid(field, &owner) == .success, owner == app.processIdentifier,
              let context = passwordFieldContext(field),
              let frame = axFrame(field), frame.width > 0, frame.height > 0,
              point.map(frame.contains) != false else { continue }
        if !signInFailed, context.origin != nil, hasPasswordText(field) {
            return ["password_present": true]
        }
        guard canFillPasswordField(field) else { continue }
        return bindPasswordField(field, in: app, context: context, frame: frame)
    }
    return [:]
}

private func bindPasswordField(_ field: AXUIElement, in app: NSRunningApplication, context: PasswordFieldContext, frame: CGRect) -> Object {
    let token = UUID().uuidString
    let now = Date()
    let login = context.loginScope != nil && isTrustedLoginBrowser(app) ? webLoginField(field, context: context) : nil
    let binding = PasswordField(element: field, window: context.window, origin: context.origin,
                                loginOrigin: login?.origin,
                                pid: app.processIdentifier, launchDate: app.launchDate, expires: now.addingTimeInterval(305))
    passwordFieldLock.lock()
    passwordFields = passwordFields.filter { $0.value.expires > now }
    if passwordFields.count >= 32, let oldest = passwordFields.min(by: { $0.value.expires < $1.value.expires }) {
        passwordFields.removeValue(forKey: oldest.key)
    }
    passwordFields[token] = binding
    passwordFieldLock.unlock()
    var destination: Object = ["app": app.localizedName ?? app.bundleIdentifier ?? "Application"]
    if let origin = context.origin { destination["origin"] = origin }
    var output: Object = ["token": token, "frame": rectObject(frame), "destination": destination]
    if let login {
        var metadata: Object = ["origin": login.origin]
        if let account = login.account { metadata["account"] = account }
        output["login"] = metadata
    }
    return output
}

private func fillPasswordField(_ args: Args) -> Object {
    guard let token = str(args, "token"),
          let password = args["password"] as? String, !password.isEmpty, password.utf16.count <= 4096,
          let binding = removePasswordField(token), binding.expires > Date(),
          let app = NSRunningApplication(processIdentifier: binding.pid), app.launchDate == binding.launchDate,
          let context = passwordFieldContext(binding.element),
          CFEqual(context.window, binding.window), context.origin == binding.origin,
          canFillPasswordField(binding.element)
    else { return ["filled": false] }
    if args["require_account_field"] as? Bool == true, hasPasswordText(binding.element) {
        return ["filled": false]
    }
    if let account = str(args, "account") {
        guard !account.isEmpty, account.utf16.count <= 512,
              let origin = binding.loginOrigin, let login = webLoginField(binding.element, context: context),
              login.origin == origin else { return ["filled": false] }
        if let field = login.accountField, let current = login.account {
            if current.isEmpty {
                guard AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, account as CFString) == .success,
                      let updated = passwordFieldContext(binding.element),
                      CFEqual(updated.window, binding.window),
                      let updatedLogin = webLoginField(binding.element, context: updated),
                      updatedLogin.origin == origin, updatedLogin.account == account,
                      let updatedField = updatedLogin.accountField, CFEqual(updatedField, field)
                else { return ["filled": false] }
            } else if current != account {
                return ["filled": false]
            }
        } else if args["require_account_field"] as? Bool == true {
            return ["filled": false]
        }
    }
    let result = AXUIElementSetAttributeValue(binding.element, kAXValueAttribute as CFString, password as CFString)
    return ["filled": result == .success]
}

private func uiFind(_ a: Args) throws -> Object {
    try requireAccessibility()
    let pid = Int(num(a, "pid") ?? 0)
    try rejectOwnApp(pid, "ui.find")
    let app = applicationElement(pid)
    var roots: [AXUIElement] = [app]
    if let title = str(a, "window_title") {
        let wanted = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let windows = (axAttribute(app, "AXWindows") as? [AXUIElement]) ?? []
        roots = windows.filter { (axName($0, role: "AXWindow") ?? "").lowercased().contains(wanted) }
    }
    var state = WalkState()
    let deadline = Date().addingTimeInterval(max(0.5, num(a, "timeout") ?? 5))
    let maxDepth = Int(num(a, "max_depth") ?? Double(maxDepthDefault))
    let maxNodes = Int(num(a, "max_nodes") ?? Double(maxNodesDefault))
    for root in roots {
        walk(root, role: str(a, "role"), name: str(a, "name"), deadline: deadline, maxDepth: maxDepth, maxNodes: maxNodes, state: &state)
        if state.truncated { break }
    }
    return ["matches": dedupe(state.results), "visited": state.visited, "roots": roots.count, "truncated": state.truncated]
}

private func centerX(_ item: Object) -> Double {
    ((item["center"] as? Object)?["x"] as? Double) ?? 0
}

private func dock(_ name: String?) throws -> Object {
    try requireAccessibility()
    guard let dockApp = liveApps().first(where: { $0.bundleIdentifier == "com.apple.dock" }) else {
        throw fail("not_found", "The Dock process is not reachable.")
    }
    var state = WalkState()
    walk(applicationElement(Int(dockApp.processIdentifier)), role: "AXDockItem", name: name, deadline: Date().addingTimeInterval(5), maxDepth: maxDepthDefault, maxNodes: maxNodesDefault, state: &state)
    let icons = dedupe(state.results).sorted { centerX($0) < centerX($1) }
    return ["icons": icons]
}

private func menubar(_ menu: String?) throws -> Object {
    try requireAccessibility()
    guard let pid = frontmostPid() else { throw fail("not_found", "No frontmost app.") }
    try rejectOwnApp(Int(pid), "ui.menubar")
    guard let bar = axAttribute(applicationElement(pid), "AXMenuBar"), CFGetTypeID(bar) == AXUIElementGetTypeID() else {
        throw fail("not_found", "pid \(pid) has no accessible menu bar.")
    }
    let wanted = menu?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    var items: [Object] = []
    for item in axChildren(bar as! AXUIElement) where axRole(item) == "AXMenuBarItem" {
        let title = axName(item, role: "AXMenuBarItem") ?? ""
        if !wanted.isEmpty && !title.lowercased().contains(wanted) { continue }
        guard let frame = axFrame(item) else { continue }
        items.append(["menu": title, "frame": rectObject(frame), "center": pointObject(CGPoint(x: frame.midX, y: frame.midY))])
    }
    return ["app_pid": pid, "items": items]
}

private func hitTest(x: Double, y: Double) throws -> Object {
    try requireAccessibility()
    var found: AXUIElement?
    let error = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &found)
    guard error == .success, let element = found else {
        throw fail("not_found", "No accessible element at (\(x), \(y)) (AXError \(error.rawValue)).")
    }
    var hitPid: pid_t = 0
    if AXUIElementGetPid(element, &hitPid) == .success {
        try rejectOwnApp(Int(hitPid), "ui.hit_test")
    }
    let role = axRole(element)
    var result: Object = ["element": describe(element, role: role, name: axName(element, role: role), frame: axFrame(element))]
    if let window = axAttribute(element, "AXWindow"), CFGetTypeID(window) == AXUIElementGetTypeID() {
        result["window_title"] = nullable(axName(window as! AXUIElement, role: "AXWindow"))
    } else {
        result["window_title"] = NSNull()
    }
    var pid: pid_t = 0
    if AXUIElementGetPid(element, &pid) == .success { result["pid"] = Int(pid) }
    return result
}

private func pngSize(_ path: String) throws -> (Int, Int) {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = props[kCGImagePropertyPixelWidth] as? Int,
          let height = props[kCGImagePropertyPixelHeight] as? Int
    else { throw fail("capture_failed", "Capture finished but the PNG could not be read.") }
    return (width, height)
}

private func capture(_ a: Args) throws -> Object {
    guard let path = str(a, "path"), !path.isEmpty else { throw fail("invalid_arguments", "path is required") }
    if !CGPreflightScreenCaptureAccess() {
        _ = CGRequestScreenCaptureAccess()
        if !CGPreflightScreenCaptureAccess() {
            throw fail("permission_required", "Screen Recording permission is required. Enable Larry Agent in System Settings → Privacy & Security → Screen & System Audio Recording, then retry.")
        }
    }
    var arguments = ["-x"]
    let rect: CGRect
    if let region = a["region"] as? [NSNumber], region.count == 4 {
        let values = region.map { $0.doubleValue }
        rect = CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
        arguments.append("-R\(Int(values[0].rounded())),\(Int(values[1].rounded())),\(Int(values[2].rounded())),\(Int(values[3].rounded()))")
    } else {
        rect = CGDisplayBounds(CGMainDisplayID())
        arguments.append("-m")
    }
    arguments.append(path)

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = arguments
    let stderr = Pipe()
    process.standardOutput = FileHandle.nullDevice
    process.standardError = stderr
    do {
        try process.run()
    } catch {
        throw fail("capture_failed", "Could not launch screencapture: \(error.localizedDescription)")
    }
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        let message = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        throw fail("capture_failed", message.isEmpty ? "screencapture exited with status \(process.terminationStatus)." : message)
    }
    let (width, height) = try pngSize(path)
    return ["path": path, "width": width, "height": height, "rect": rectObject(rect)]
}

private func box(_ text: String, _ rect: CGRect, imageWidth: Double, imageHeight: Double) -> Object {
    let x = Double(rect.minX) * imageWidth
    let y = (1 - Double(rect.maxY)) * imageHeight
    return [
        "text": text,
        "x": r1(x),
        "y": r1(y),
        "width": r1(Double(rect.width) * imageWidth),
        "height": r1(Double(rect.height) * imageHeight),
    ]
}

private func ocr(_ a: Args) throws -> Object {
    guard let path = str(a, "path"),
          let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw fail("not_found", "Image not found or unreadable: \(str(a, "path") ?? "")") }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let wanted = (a["languages"] as? [String]) ?? []
    let supported = (try? request.supportedRecognitionLanguages()) ?? []
    let languages = wanted.filter { supported.isEmpty || supported.contains($0) }
    if !languages.isEmpty { request.recognitionLanguages = languages }

    do {
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    } catch {
        throw fail("ocr_failed", "OCR failed: \(error.localizedDescription)")
    }

    let width = Double(image.width)
    let height = Double(image.height)
    var lines: [Object] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string
        var line = box(text, observation.boundingBox, imageWidth: width, imageHeight: height)
        var words: [Object] = []
        text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .byWords) { word, range, _, _ in
            guard let word, let rect = try? candidate.boundingBox(for: range) else { return }
            words.append(box(word, rect.boundingBox, imageWidth: width, imageHeight: height))
        }
        if !words.isEmpty { line["words"] = words }
        lines.append(line)
    }
    return ["width": image.width, "height": image.height, "language": languages.first ?? "", "lines": lines]
}

private func dispatch(_ cmd: String, _ a: Args) throws -> Object {
    switch cmd {
    case "ping":
        return ["version": helperVersion, "platform": "macos", "pid": Int(getpid())]
    case "system.info":
        return systemInfo()
    case "permissions.request":
        return permissions(prompt: true)
    case "screens":
        return ["screens": screens()]
    case "mouse.position":
        return pointObject(cursor())
    case "input.activity":
        return inputActivity()
    case "input.sequence":
        return try runSequence(a)
    case "input.hover":
        return try inputHover(a)
    case "input.click_at":
        return try inputClickAt(a)
    case "input.drag_path":
        return try inputDragPath(a)
    case "input.scroll_at":
        return try inputScrollAt(a)
    case "input.button_at":
        return try inputButtonAt(a)
    case "key.char_vk":
        return ["vk": NSNull()]
    case "ui.find_app":
        return ["app": nullable(findApp(a["target"]))]
    case "ui.windows":
        return ["windows": appWindows(Int(num(a, "pid") ?? 0))]
    case "ui.find":
        return try uiFind(a)
    case "ui.batch_state":
        return try batchDesktopState(a)
    case "ui.prepare_password":
        return try preparePasswordField(a)
    case "ui.fill_password":
        return fillPasswordField(a)
    case "ui.discard_password":
        if let token = str(a, "token") { _ = removePasswordField(token) }
        return [:]
    case "ui.dock":
        return try dock(str(a, "name"))
    case "ui.menubar":
        return try menubar(str(a, "menu"))
    case "ui.hit_test":
        return try hitTest(x: num(a, "x") ?? 0, y: num(a, "y") ?? 0)
    case "screen.capture":
        return try capture(a)
    case "screen.ocr":
        return try ocr(a)
    default:
        throw fail("unknown_command", "Unknown command: \(cmd)")
    }
}

private func responseObject(_ line: String) -> Object {
    var id: Any = NSNull()
    do {
        guard let data = line.data(using: .utf8),
              let request = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw fail("invalid_request", "Request must be a JSON object.") }
        id = request["id"] ?? NSNull()
        let result = try dispatch(request["cmd"] as? String ?? "", request["args"] as? Args ?? [:])
        return ["id": id, "ok": true, "result": result]
    } catch let error as HelperError {
        return ["id": id, "ok": false, "code": error.code, "error": error.message]
    } catch {
        return ["id": id, "ok": false, "code": "native_error", "error": error.localizedDescription]
    }
}

private func responseJSON(_ line: String) -> String {
    encodeObject(responseObject(line))
}

private func handleLine(_ line: String) {
    emit(responseObject(line))
}

@_cdecl("jb_computer_use_dispatch")
public func jbComputerUseDispatch(_ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    strdup(responseJSON(String(cString: request)))
}

public func runHelperLoop() {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    emit(["ready": true, "version": helperVersion, "pid": Int(getpid())])

    let reader = Thread {
        while let line = readLine(strippingNewline: true) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.main.async {
                handleLine(trimmed)
                done.signal()
            }
            done.wait()
        }
        exit(0)
    }
    reader.start()
    RunLoop.main.run()
}

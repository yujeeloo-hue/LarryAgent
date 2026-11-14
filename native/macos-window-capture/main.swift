import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

private struct Arguments {
    let appName: String
    let outputPath: String
    let windowTitle: String?

    static func parse(_ values: [String]) throws -> Arguments {
        var appName: String?
        var outputPath: String?
        var windowTitle: String?
        var index = 1

        while index < values.count {
            let flag = values[index]
            guard index + 1 < values.count else {
                throw CaptureError.invalidArguments("Missing value for \(flag)")
            }
            let value = values[index + 1]
            switch flag {
            case "--app":
                appName = value
            case "--output":
                outputPath = value
            case "--window-title":
                windowTitle = value
            default:
                throw CaptureError.invalidArguments("Unknown argument: \(flag)")
            }
            index += 2
        }

        guard let appName, !appName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CaptureError.invalidArguments("--app is required")
        }
        guard let outputPath, !outputPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CaptureError.invalidArguments("--output is required")
        }
        return Arguments(
            appName: appName.trimmingCharacters(in: .whitespacesAndNewlines),
            outputPath: outputPath,
            windowTitle: windowTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }
}

private enum CaptureError: LocalizedError {
    case invalidArguments(String)
    case permissionRequired
    case appNotFound(String, [String])
    case windowNotFound(String)
    case captureFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments(let message):
            return message
        case .permissionRequired:
            return "Screen Recording permission is required. Enable it in System Settings → Privacy & Security → Screen & System Audio Recording for this app, then quit and reopen."
        case .appNotFound(let appName, let available):
            let suffix = available.isEmpty ? "" : " Available apps: \(available.joined(separator: ", "))."
            return "No visible windows found for app \(appName).\(suffix)"
        case .windowNotFound(let title):
            return "No visible window title contains \(title)."
        case .captureFailed(let message):
            return message
        }
    }

    var code: String {
        switch self {
        case .invalidArguments: return "invalid_arguments"
        case .permissionRequired: return "permission_required"
        case .appNotFound: return "app_not_found"
        case .windowNotFound: return "window_not_found"
        case .captureFailed: return "capture_failed"
        }
    }
}

private struct HelperResponse: Encodable {
    let ok: Bool
    let path: String?
    let appName: String?
    let windowTitle: String?
    let windowId: UInt32?
    let width: Int?
    let height: Int?
    let errorCode: String?
    let message: String?
}

private struct WindowCandidate {
    let windowId: UInt32
    let appName: String
    let bundleId: String?
    let title: String?
    let width: CGFloat
    let height: CGFloat

    var area: CGFloat { width * height }
}

private func emit(_ response: HelperResponse) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(response),
          let text = String(data: data, encoding: .utf8) else {
        FileHandle.standardOutput.write(Data("{\"ok\":false,\"errorCode\":\"capture_failed\",\"message\":\"Could not encode helper response.\"}\n".utf8))
        return
    }
    FileHandle.standardOutput.write(Data((text + "\n").utf8))
}

private func emitFailure(_ error: CaptureError) {
    emit(HelperResponse(
        ok: false,
        path: nil,
        appName: nil,
        windowTitle: nil,
        windowId: nil,
        width: nil,
        height: nil,
        errorCode: error.code,
        message: error.localizedDescription
    ))
}

private func normalized(_ value: String) -> String {
    value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func listOnScreenWindows() throws -> [WindowCandidate] {
    guard let info = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else {
        throw CaptureError.captureFailed("Could not enumerate on-screen windows.")
    }

    let bundleByPid: [Int32: String] = Dictionary(
        uniqueKeysWithValues: NSWorkspace.shared.runningApplications.compactMap { app in
            guard let bundleId = app.bundleIdentifier else { return nil }
            return (app.processIdentifier, bundleId)
        }
    )

    return info.compactMap { entry in
        guard
            let windowId = entry[kCGWindowNumber as String] as? UInt32,
            let owner = entry[kCGWindowOwnerName as String] as? String,
            let bounds = entry[kCGWindowBounds as String] as? [String: Any],
            let width = bounds["Width"] as? CGFloat,
            let height = bounds["Height"] as? CGFloat,
            width > 1,
            height > 1
        else {
            return nil
        }

        // Layer 0 is the normal app window layer.
        if let layer = entry[kCGWindowLayer as String] as? Int, layer != 0 {
            return nil
        }

        let title = entry[kCGWindowName as String] as? String
        let pid = entry[kCGWindowOwnerPID as String] as? Int32
        let bundleId = pid.flatMap { bundleByPid[$0] }

        return WindowCandidate(
            windowId: windowId,
            appName: owner,
            bundleId: bundleId,
            title: title,
            width: width,
            height: height
        )
    }
}

private func availableApplicationNames(_ windows: [WindowCandidate]) -> [String] {
    Array(Set(windows.map(\.appName))).sorted().prefix(12).map { $0 }
}

private func selectWindow(
    from windows: [WindowCandidate],
    appName: String,
    windowTitle: String?
) throws -> WindowCandidate {
    let wantedApp = normalized(appName)
    let appMatches = windows.filter { window in
        normalized(window.appName) == wantedApp
            || normalized(window.bundleId ?? "") == wantedApp
    }

    guard !appMatches.isEmpty else {
        throw CaptureError.appNotFound(appName, availableApplicationNames(windows))
    }

    let titleMatches: [WindowCandidate]
    if let windowTitle, !windowTitle.isEmpty {
        let wantedTitle = normalized(windowTitle)
        titleMatches = appMatches.filter { normalized($0.title ?? "").contains(wantedTitle) }
        guard !titleMatches.isEmpty else {
            throw CaptureError.windowNotFound(windowTitle)
        }
    } else {
        titleMatches = appMatches
    }

    guard let selected = titleMatches.max(by: { $0.area < $1.area }) else {
        throw CaptureError.captureFailed("Could not select a matching window.")
    }
    return selected
}

private func runScreencapture(windowId: UInt32, outputPath: String) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-l", String(windowId), outputPath]
    let stderr = Pipe()
    process.standardOutput = FileHandle.nullDevice
    process.standardError = stderr
    do {
        try process.run()
    } catch {
        throw CaptureError.captureFailed("Could not launch screencapture: \(error.localizedDescription)")
    }
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        let errData = stderr.fileHandleForReading.readDataToEndOfFile()
        let errText = String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if errText.localizedCaseInsensitiveContains("permission")
            || errText.localizedCaseInsensitiveContains("not authorized")
        {
            throw CaptureError.permissionRequired
        }
        throw CaptureError.captureFailed(
            errText.isEmpty
                ? "screencapture exited with status \(process.terminationStatus)."
                : errText
        )
    }
}

private func pngSize(at path: String) throws -> (width: Int, height: Int) {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let source = CGImageSourceCreateWithURL(url, nil),
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = props[kCGImagePropertyPixelWidth] as? Int,
          let height = props[kCGImagePropertyPixelHeight] as? Int,
          width > 0,
          height > 0
    else {
        throw CaptureError.captureFailed("Capture finished but the PNG could not be read.")
    }
    return (width, height)
}

private func runCapture(args: Arguments) throws {
    // Request access so the parent Electron/Terminal binary shows up in TCC when needed.
    if !CGPreflightScreenCaptureAccess() {
        _ = CGRequestScreenCaptureAccess()
    }

    let windows = try listOnScreenWindows()
    // Empty owner names often mean Screen Recording is denied for this process.
    if windows.allSatisfy({ $0.appName.isEmpty }) {
        throw CaptureError.permissionRequired
    }

    let window = try selectWindow(
        from: windows,
        appName: args.appName,
        windowTitle: args.windowTitle
    )
    try runScreencapture(windowId: window.windowId, outputPath: args.outputPath)
    let size = try pngSize(at: args.outputPath)

    emit(HelperResponse(
        ok: true,
        path: args.outputPath,
        appName: window.appName,
        windowTitle: window.title,
        windowId: window.windowId,
        width: size.width,
        height: size.height,
        errorCode: nil,
        message: nil
    ))
}

@main
private enum WindowCaptureHelper {
    static func main() {
        // CLI helpers that touch CoreGraphics must create NSApplication first;
        // otherwise CoreGraphics asserts with CGS_REQUIRE_INIT.
        let nsApp = NSApplication.shared
        nsApp.setActivationPolicy(.accessory)

        do {
            let args = try Arguments.parse(CommandLine.arguments)
            try runCapture(args: args)
            Foundation.exit(0)
        } catch let error as CaptureError {
            emitFailure(error)
            Foundation.exit(1)
        } catch {
            emitFailure(.captureFailed(error.localizedDescription))
            Foundation.exit(1)
        }
    }
}

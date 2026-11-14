import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
    fatalError("Usage: prepare-dmg-alias <folder-icon.png> <Applications.alias>")
}

let iconURL = URL(fileURLWithPath: CommandLine.arguments[1])
let aliasURL = URL(fileURLWithPath: CommandLine.arguments[2])
let applicationsURL = URL(fileURLWithPath: "/Applications", isDirectory: true)

guard FileManager.default.fileExists(atPath: applicationsURL.path) else {
    fatalError("/Applications is missing")
}
guard let icon = NSImage(contentsOf: iconURL) else {
    fatalError("Cannot open folder icon: \(iconURL.path)")
}

try? FileManager.default.removeItem(at: aliasURL)
let bookmark = try applicationsURL.bookmarkData(
    options: .suitableForBookmarkFile,
    includingResourceValuesForKeys: nil,
    relativeTo: nil
)
try URL.writeBookmarkData(bookmark, to: aliasURL)

guard NSWorkspace.shared.setIcon(icon, forFile: aliasURL.path, options: []) else {
    fatalError("Cannot set the Applications alias icon")
}
let resolved = try URL(resolvingAliasFileAt: aliasURL, options: [.withoutUI])
guard resolved.standardizedFileURL.path == applicationsURL.path else {
    fatalError("Applications alias resolves to \(resolved.path), expected /Applications")
}
print("Prepared \(aliasURL.path) -> \(resolved.path)")

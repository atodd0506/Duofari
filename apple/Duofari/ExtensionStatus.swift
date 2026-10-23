//
//  ExtensionStatus.swift
//  Duofari
//
//  Whether Duofari is switched on in Safari, and a shortcut to its settings.
//

import SafariServices
import UIKit

enum ExtensionStatus: Equatable {
    case checking
    case on
    case off
    case unknown

    /// The web extension's bundle identifier: the app's own plus ".Extension".
    static var extensionIdentifier: String? {
        Bundle.main.bundleIdentifier.map { $0 + ".Extension" }
    }

    /// Asks Safari for the extension's current state.
    static func fetch() async -> ExtensionStatus {
        guard let identifier = extensionIdentifier else { return .unknown }
        do {
            let state = try await SFSafariExtensionManager.stateOfExtension(withIdentifier: identifier)
            return state.isEnabled ? .on : .off
        } catch {
            return .unknown
        }
    }

    /// Opens Duofari's page in Safari's extension settings. Returns false if
    /// Safari couldn't show it, so the caller can open the Settings app instead.
    /// Safari only shows the page while the app is in the foreground.
    static func openSettings() async -> Bool {
        guard let identifier = extensionIdentifier else { return false }
        do {
            try await SFSafariSettings.openExtensionsSettings(forIdentifiers: [identifier])
            return true
        } catch {
            return false
        }
    }
}

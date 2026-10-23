//
//  SafariWebExtensionHandler.swift
//  Duofari Extension
//
//  Duofari does its work in JavaScript inside Safari. The one thing the web
//  extension can't see from a page is the device itself, so the background
//  script asks here once:
//
//      browser.runtime.sendNativeMessage("application.id", { type: "device" })
//
//  and gets back the screen size in points, its scale factors and the hardware
//  model, e.g. { screenWidth: 466, screenHeight: 678, scale: 3, nativeScale: 3,
//  model: "iPhone19,1" }. Any other message is answered with { ok: true }.
//

import SafariServices
import UIKit
import os.log

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey]
        os_log(.debug, "Duofari received a native message: %@", String(describing: message))

        let type = (message as? [String: Any])?["type"] as? String
        if type == "device" {
            // UIScreen belongs to the main thread.
            Task { @MainActor in
                let info = SafariWebExtensionHandler.deviceInfo()
                SafariWebExtensionHandler.complete(context, with: info)
            }
        } else {
            SafariWebExtensionHandler.complete(context, with: ["ok": true])
        }
    }

    /// Sends the reply. Each request must be completed exactly once.
    private static func complete(_ context: NSExtensionContext, with reply: [String: Any]) {
        os_log(.debug, "Duofari replies: %@", String(describing: reply))
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    /// The main screen's size and scale, and the hardware model.
    /// `UIScreen.main` is deprecated but still the only screen an extension
    /// handler can reach, since it has no window scene of its own.
    @MainActor
    private static func deviceInfo() -> [String: Any] {
        let screen = UIScreen.main
        return [
            "screenWidth": Double(screen.bounds.width),
            "screenHeight": Double(screen.bounds.height),
            "scale": Double(screen.scale),
            "nativeScale": Double(screen.nativeScale),
            "model": machineIdentifier(),
        ]
    }

    /// The hardware model, such as "iPhone19,1". In the Simulator this is the
    /// simulated device's model rather than the Mac's architecture.
    private static func machineIdentifier() -> String {
        #if targetEnvironment(simulator)
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !simulated.isEmpty {
            return simulated
        }
        #endif
        var info = utsname()
        guard uname(&info) == 0 else { return "" }
        return withUnsafeBytes(of: &info.machine) { bytes in
            String(decoding: bytes.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
    }
}

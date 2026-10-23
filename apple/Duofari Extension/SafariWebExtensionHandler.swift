//
//  SafariWebExtensionHandler.swift
//  Duofari Extension
//
//  Duofari does all of its work in JavaScript inside Safari and never talks to
//  native code. Safari still requires a principal class for the extension, so
//  this handler answers any native message with an empty acknowledgement.
//

import SafariServices
import os.log

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey]
        os_log(.debug, "Duofari received a native message: %@", String(describing: message))

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["ok": true]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

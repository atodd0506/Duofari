//
//  DeviceInfo.swift
//  Duofari
//
//  Recognises iPhone Duo's outer display, the only iPhone screen where
//  Safari keeps its controls in a side column.
//

import UIKit

struct DeviceInfo: Equatable {
    let isDuo: Bool

    /// Long side over short side of iPhone Duo's outer display (466 × 678 pt),
    /// about 1.455. Every other iPhone is at least 16 : 9 (1.78), and most are
    /// taller than 2 : 1.
    static let duoAspectRatio: CGFloat = 678.0 / 466.0

    /// Matches by shape and scale rather than exact size, because Display Zoom
    /// changes the size in points but not the proportions. The scale rules out
    /// iPads (2x), which can also run iPhone apps.
    static func matchesDuo(bounds: CGRect, scale: CGFloat, idiom: UIUserInterfaceIdiom) -> Bool {
        let short = min(bounds.width, bounds.height)
        let long = max(bounds.width, bounds.height)
        guard idiom == .phone, short > 0 else { return false }
        return abs(long / short - duoAspectRatio) < 0.03 && scale >= 2.5
    }

    /// The screen the app is on, as seen through its window scene. On iPhone
    /// Duo's inner display this is false too, which is right: Safari has no
    /// side column there. Call on the main thread.
    static var current: DeviceInfo {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else {
            return DeviceInfo(isDuo: false)
        }
        let screen = scene.screen
        let isDuo = matchesDuo(bounds: screen.bounds, scale: screen.scale, idiom: scene.traitCollection.userInterfaceIdiom)
        return DeviceInfo(isDuo: isDuo)
    }
}

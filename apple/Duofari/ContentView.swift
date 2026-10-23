//
//  ContentView.swift
//  Duofari
//
//  Onboarding: what Duofari does, where it applies, and how to enable it.
//

import SwiftUI
import UIKit

struct ContentView: View {
    @Environment(\.openURL) private var openURL

    private let device = DeviceInfo.current

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    header
                    if !device.isDuo {
                        notice(
                            symbol: "info.circle",
                            text: "This iPhone doesn’t have Safari’s side column, so Duofari will stay idle here. It’s made for the folded iPhone Duo."
                        )
                    }
                    section("What it does") {
                        bullet("rectangle.righthalf.inset.filled", "Header bars, hero art and full-width images continue under Safari’s side controls, the way the App Store and other Apple apps do on iPhone Duo.")
                        bullet("text.alignleft", "Text, buttons and links stay clear of the column, so nothing you read or tap ends up behind the controls.")
                        bullet("arrow.left.and.right.square", "Pages are held steady, so they don’t slide sideways as you scroll. Pinch to zoom works as usual.")
                    }
                    section("Where it works") {
                        bullet("iphone", "On the outer display, when iPhone Duo is folded. That’s where Safari keeps its buttons in a column down the side.")
                        bullet("ipad.landscape", "When the phone is open, Safari uses the full width of the inner display, so Duofari leaves pages alone.")
                    }
                    section("Turn it on") {
                        step(1, "Open **Settings › Apps › Safari › Extensions**.")
                        step(2, "Tap **Duofari** and switch on **Allow Extension**.")
                        step(3, "Under **Permissions**, set **All Websites** to **Allow**, so Duofari can adjust every page without asking each time.")
                        step(4, "Reload any Safari tabs that were already open.")
                        Button {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                openURL(url)
                            }
                        } label: {
                            Label("Open Settings", systemImage: "gear")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .padding(.top, 4)
                    }
                    section("Fine-tune") {
                        bullet("puzzlepiece.extension", "In Safari, tap the extensions button and choose Duofari to turn it off for a site, choose how images extend, or show the debug outline.")
                    }
                    section("Privacy") {
                        bullet("hand.raised", "Duofari runs entirely on your iPhone. It doesn’t collect, store or send anything about the pages you visit.")
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
                .frame(maxWidth: 640, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle("Duofari")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            Image("Logo")
                .resizable()
                .frame(width: 72, height: 72)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Duofari")
                    .font(.largeTitle.bold())
                Text("Full-width pages for Safari on iPhone Duo")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.title3.bold())
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func bullet(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(.tint)
                .frame(width: 24)
                .accessibilityHidden(true)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func step(_ number: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.callout.bold().monospacedDigit())
                .foregroundStyle(.white)
                .frame(width: 24, height: 24)
                .background(Circle().fill(.tint))
                .accessibilityHidden(true)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func notice(symbol: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol)
                .accessibilityHidden(true)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(.secondarySystemBackground)))
    }
}

/// Recognises iPhone Duo by its screen size: UIKit reports the outer display's
/// 466 × 678 pt bounds in every pose, and no other iPhone has that size.
struct DeviceInfo {
    let isDuo: Bool

    static var current: DeviceInfo {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard let bounds = scene?.screen.bounds else { return DeviceInfo(isDuo: false) }
        let short = min(bounds.width, bounds.height)
        let long = max(bounds.width, bounds.height)
        return DeviceInfo(isDuo: abs(short - 466) <= 1 && abs(long - 678) <= 1)
    }
}

#Preview {
    ContentView()
}

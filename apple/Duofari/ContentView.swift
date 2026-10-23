//
//  ContentView.swift
//  Duofari
//
//  Onboarding: what Duofari does, where it applies, whether it's on, and how
//  to turn it on.
//

import SwiftUI
import UIKit

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    @State private var device = DeviceInfo.current
    @State private var status: ExtensionStatus = .checking

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    header
                    if !device.isDuo {
                        notice(symbol: "info.circle", tint: Color(.secondaryLabel),
                               text: "Duofari works on iPhone Duo’s outer display, where Safari keeps its controls in a side column. On this screen Safari has no column, so Duofari stays idle.")
                    }
                    statusRow
                    section("How it looks") {
                        HowItLooksIllustration()
                    }
                    section("What it does") {
                        bullet("rectangle.righthalf.inset.filled", "Header bars, hero art and full-width images continue under Safari’s side controls, the way the App Store and other Apple apps do on iPhone Duo.")
                        bullet("text.alignleft", "Text, buttons and links stay clear of the column, so nothing you read or tap ends up behind the controls.")
                        bullet("arrow.left.and.right.square", "Pages are held steady, so they don’t slide sideways as you scroll. Pinch to zoom works as usual.")
                    }
                    section("Where it works") {
                        bullet("iphone", "Only on the outer display, when iPhone Duo is folded. That’s where Safari keeps its controls in a column down the side.")
                        bullet("ipad.landscape", "On the inner display, Safari uses the full width, so Duofari leaves pages alone.")
                    }
                    section("Turn it on") {
                        step(1, "Open **Settings › Apps › Safari › Extensions › Duofari**, or tap the button below.")
                        step(2, "Switch on **Allow Extension**. Do the same for each Safari profile you use, and for **Private Browsing** if you want it there too.")
                        step(3, "Under **Permissions**, set **All Websites** to **Allow**.")
                        step(4, "Reload any tabs that were already open.")
                        Button {
                            Task { await openExtensionSettings() }
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
        // Check again whenever the app comes back, e.g. from Settings.
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await refresh()
        }
    }

    // MARK: - Actions

    @MainActor
    private func refresh() async {
        device = DeviceInfo.current
        let latest = await ExtensionStatus.fetch()
        if !Task.isCancelled {
            status = latest
        }
    }

    /// Opens Duofari's page in Safari's extension settings, or the Settings
    /// app if Safari can't show it.
    @MainActor
    private func openExtensionSettings() async {
        if await ExtensionStatus.openSettings() {
            return
        }
        if let url = URL(string: UIApplication.openSettingsURLString) {
            openURL(url)
        }
    }

    // MARK: - Pieces

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

    @ViewBuilder
    private var statusRow: some View {
        switch status {
        case .checking:
            notice(symbol: "ellipsis.circle", tint: Color(.secondaryLabel), text: "Checking whether Duofari is on…")
        case .on:
            notice(symbol: "checkmark.circle.fill", tint: .green, text: "Duofari is on in Safari")
        case .off:
            notice(symbol: "exclamationmark.circle.fill", tint: .orange, text: "Duofari is off — turn it on in Settings")
        case .unknown:
            notice(symbol: "questionmark.circle", tint: Color(.secondaryLabel), text: "Couldn’t check whether Duofari is on. Open Settings to see.")
        }
    }

    private func section<Content: View>(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.title3.bold())
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func bullet(_ symbol: String, _ text: LocalizedStringKey) -> some View {
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
            Text(number, format: .number)
                .font(.callout.bold().monospacedDigit())
                .foregroundStyle(.white)
                .frame(width: 24, height: 24)
                .background(Circle().fill(.tint))
                .accessibilityHidden(true)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func notice(symbol: String, tint: Color, text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(.secondarySystemBackground)))
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    ContentView()
}

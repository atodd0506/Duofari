//
//  HowItLooksIllustration.swift
//  Duofari
//
//  A small before/after sketch of a web page on the folded iPhone Duo, drawn
//  with shapes so it follows Light and Dark Mode without any images.
//

import SwiftUI

struct HowItLooksIllustration: View {
    var body: some View {
        HStack(alignment: .top, spacing: 24) {
            MiniPhone(extended: false, caption: "Without Duofari")
            MiniPhone(extended: true, caption: "With Duofari")
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Two sketches of a web page on the folded iPhone Duo. Without Duofari, the colored header stops at Safari’s side column. With Duofari, the header continues under the column and Safari’s controls float over it like glass. Text stays to the left of the column in both."))
    }
}

/// One phone showing a page with a header, a few lines of text and Safari's
/// controls in a column on the right.
private struct MiniPhone: View {
    let extended: Bool
    let caption: LocalizedStringKey

    // The outer display's proportions: 466 × 678 pt, with an 84-pt column.
    private static let width: CGFloat = 120
    private static let height: CGFloat = (width * 678 / 466).rounded()
    private static let column: CGFloat = (width * 84 / 466).rounded()
    private static let headerHeight: CGFloat = 44
    private static let lineWidths: [CGFloat] = [1, 0.85, 1, 0.7, 0.95, 0.55]

    var body: some View {
        VStack(spacing: 8) {
            screen
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(5)
                .background {
                    // The phone's frame, outlined so it shows in Dark Mode too.
                    RoundedRectangle(cornerRadius: 19, style: .continuous)
                        .fill(Color.black)
                        .overlay {
                            RoundedRectangle(cornerRadius: 19, style: .continuous)
                                .strokeBorder(Color(.separator), lineWidth: 1)
                        }
                }
            Text(caption)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: Self.width + 10)
        }
    }

    private var screen: some View {
        let contentWidth = Self.width - Self.column
        return ZStack(alignment: .topLeading) {
            Color(.systemBackground)

            // Without Duofari, Safari's column is a separate strip beside the page.
            if !extended {
                Color(.secondarySystemBackground)
                    .frame(width: Self.column)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }

            // The page's header: it stops at the column, or runs underneath it.
            Rectangle()
                .fill(Color.indigo.gradient)
                .frame(width: extended ? Self.width : contentWidth, height: Self.headerHeight)

            // Text always stays left of the column.
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Self.lineWidths.indices, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(Color(.systemGray4))
                        .frame(width: (contentWidth - 16) * Self.lineWidths[index], height: 5)
                }
            }
            .padding(.leading, 8)
            .padding(.top, Self.headerHeight + 12)

            // Safari's controls: a capsule at the top and two buttons below.
            VStack(spacing: 8) {
                control(Capsule(), width: 14, height: 34)
                Spacer(minLength: 0)
                control(Circle(), width: 14, height: 14)
                control(Circle(), width: 14, height: 14)
            }
            .padding(.vertical, 10)
            .frame(width: Self.column)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
        }
        .frame(width: Self.width, height: Self.height)
    }

    /// A Safari control: plain grey before, translucent glass after.
    private func control<S: InsettableShape>(_ shape: S, width: CGFloat, height: CGFloat) -> some View {
        shape
            .fill(extended ? AnyShapeStyle(Material.ultraThinMaterial) : AnyShapeStyle(Color(.systemGray3)))
            .overlay {
                shape.strokeBorder(Color.white.opacity(extended ? 0.5 : 0), lineWidth: 0.5)
            }
            .shadow(color: Color.black.opacity(extended ? 0.15 : 0), radius: 2, y: 1)
            .frame(width: width, height: height)
    }
}

#Preview {
    HowItLooksIllustration()
        .padding()
}

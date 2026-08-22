public import SwiftUI
import DarkroomCore

/// Chooses a film stock.
///
/// Grouped by manufacturer and kind, because that is how photographers think
/// about stock — someone reaching for Portra is reaching for a Kodak portrait
/// negative, not for entry forty-one in an alphabetical list.
public struct LookPicker: View {

    @Bindable public var editor: Editor

    /// Per-stock previews, filled in after the picker appears.
    @State private var thumbnails: [String: CGImage] = [:]

    public init(editor: Editor) {
        self.editor = editor
    }

    private var selectedID: String? {
        if case let .filmStock(id) = editor.state.look { return id }
        return nil
    }

    public var body: some View {
        GlassPaneStack {
            if !editor.state.look.isNone {
                InspectorCard(
                    title: "Applied Look",
                    id: "looks.applied",
                    editor: editor,
                    reset: { editor.update({ $0.look = .none }, label: "Remove Look") },
                    isModified: true
                ) {
                    VStack(alignment: .leading, spacing: 10) {
                        intensity
                        noneButton
                    }
                }
            }

            ForEach(FilmCategory.ordered) { category in
                let stocks = FilmStock.allStocks.filter { $0.category == category }
                if !stocks.isEmpty {
                    InspectorCard(
                        title: category.title,
                        id: "looks.\(category.id)",
                        editor: editor
                    ) {
                        VStack(spacing: 1) {
                            ForEach(stocks) { stock in
                                LookRow(
                                    stock: stock,
                                    thumbnail: thumbnails[stock.id],
                                    isSelected: selectedID == stock.id
                                ) {
                                    editor.update(
                                        { $0.look = .filmStock(id: stock.id) },
                                        label: stock.name
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, InspectorGeometry.panelInset)
        // Rebuilt when the photograph changes: a preview of "Portra 400" that
        // still shows the previous image is worse than none at all.
        .task(id: editor.sourceURL) {
            thumbnails = [:]
            let base = LookThumbnails.baseImage(source: editor.sourceImage)
            for stock in FilmStock.allStocks {
                if Task.isCancelled { return }
                if let image = LookThumbnails.render(stock, over: base, context: editor.renderContext) {
                    thumbnails[stock.id] = image
                }
                // Every few stocks, let the display catch up — the picker
                // filling in progressively reads better than a pause and a
                // completed grid.
                if FilmStock.allStocks.firstIndex(of: stock).map({ $0 % 6 == 5 }) == true {
                    await Task.yield()
                }
            }
        }
    }

    /// Shown only when a look is applied — an intensity control with nothing to
    /// scale is a dead control that still asks to be read.
    @ViewBuilder
    private var intensity: some View {
        if !editor.state.look.isNone {
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("Intensity")
                        .font(.system(size: 11, weight: .medium))
                    Spacer()
                    Text("\(Int(editor.state.lookIntensity))%")
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .monospacedDigit()
                }
                Slider(
                    value: Binding(
                        get: { editor.state.lookIntensity },
                        set: { value in
                            editor.beginInteraction(label: "Look Intensity")
                            editor.preview { $0.lookIntensity = value }
                        }
                    ),
                    in: 0...100,
                    onEditingChanged: { editing in
                        if !editing { editor.endInteraction() }
                    }
                )
                .controlSize(.small)
            }
        }
    }

    private var noneButton: some View {
        Button {
            editor.update({ $0.look = .none }, label: "No Look")
        } label: {
            HStack {
                Text("None").font(.system(size: 12))
                Spacer()
                if editor.state.look.isNone {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .semibold))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(editor.state.look.isNone ? Color.accentColor : .secondary)
    }
}

/// One stock in the list.
struct LookRow: View {
    let stock: FilmStock
    let thumbnail: CGImage?
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                // The stock applied to the open photograph — the difference
                // between choosing a look and choosing a name.
                if let thumbnail {
                    Image(decorative: thumbnail, scale: 1)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 44, height: 30)
                        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                } else {
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                        .frame(width: 44, height: 30)
                }

                VStack(alignment: .leading, spacing: 1) {
                    Text(stock.name)
                        .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                    // The stock's character in a few words. Someone who has not
                    // shot Eterna has no idea what it looks like from its name,
                    // and "muted cinema negative" is most of what they need.
                    Text(stock.summary)
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }

                Spacer(minLength: 4)

                if stock.grain != nil {
                    Image(systemName: "circle.grid.3x3.fill")
                        .font(.system(size: 8))
                        .foregroundStyle(.quaternary)
                        .help("This stock carries film grain")
                }

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background {
                RoundedRectangle(cornerRadius: 6)
                    .fill(
                        isSelected ? Color.accentColor.opacity(0.14)
                            : isHovering ? Color.primary.opacity(0.06)
                            : Color.clear
                    )
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .accessibilityLabel(stock.name)
        .accessibilityHint(stock.summary)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

public import SwiftUI
import DarkroomCore
import DarkroomRender

/// Chooses a film stock.
///
/// Grouped by manufacturer and kind, because that is how photographers think
/// about stock — someone reaching for Portra is reaching for a Kodak portrait
/// negative, not for entry forty-one in an alphabetical list.
public struct LookPicker: View {

    @Bindable public var editor: Editor

    /// The pinned search field's query, owned by the inspector so the field
    /// can stay above the scroll view while the filtering happens here.
    let searchText: String

    /// The name being typed for a new user look, while the alert is up.
    @State private var pendingLookName = ""
    @State private var isNamingLook = false

    public init(editor: Editor, searchText: String = "") {
        self.editor = editor
        self.searchText = searchText
    }

    private var selectedID: String? {
        if case let .filmStock(id) = editor.state.look { return id }
        return nil
    }

    /// The query, normalised once for every comparison below.
    private var query: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isSearching: Bool { !query.isEmpty }

    /// A stock matches on its name, its character summary, or its category —
    /// "warm" should find Sunset Portrait as surely as "Portra" finds Portra,
    /// and "kodak" should gather every stock Kodak makes.
    private func matchesQuery(_ stock: FilmStock) -> Bool {
        stock.name.localizedCaseInsensitiveContains(query)
            || stock.summary.localizedCaseInsensitiveContains(query)
            || stock.category.title.localizedCaseInsensitiveContains(query)
    }

    public var body: some View {
        GlassPaneStack {
            if isSearching {
                searchResults
            } else {
                browsedContent
            }
        }
        .padding(.horizontal, InspectorGeometry.panelInset)
        .alert("Name this look", isPresented: $isNamingLook) {
            TextField("Look name", text: $pendingLookName)
            Button("Save") { editor.saveAsUserLook(name: pendingLookName) }
                .disabled(pendingLookName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The grade — tone, colour, curves, look and qualifier — is saved. Crop and input decode stay with the photograph.")
        }
    }

    /// The library at rest: the applied look's controls, the photographer's
    /// own grades, then every stock grouped by category.
    @ViewBuilder
    private var browsedContent: some View {
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

        // The photographer's own grades, ahead of the built-ins: a look
        // someone made is worth more to them than any stock we shipped.
        InspectorCard(
            title: "My Looks",
            id: "looks.user",
            editor: editor
        ) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(editor.userLooks) { look in
                    UserLookRow(
                        look: look,
                        isActive: look.matches(editor.state),
                        onApply: { editor.applyUserLook(look) },
                        onDelete: { editor.deleteUserLook(look) }
                    )
                }

                Button {
                    pendingLookName = ""
                    isNamingLook = true
                } label: {
                    Label("Save Current Grade as Look…", systemImage: "plus")
                        .font(.system(size: 12))
                }
                .buttonStyle(.plain)
                .foregroundStyle(
                    editor.state.isNeutral
                        ? Color.primary.opacity(0.25)
                        : Color.accentColor
                )
                .disabled(editor.state.isNeutral)
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

    /// The library, filtered: one flat result list rather than sections.
    ///
    /// Sections exist to be browsed; a query is not browsing. Someone who
    /// typed "portra" wants the matching rows and nothing else, the same way
    /// Find My collapses its list to what matches — and a search that finds
    /// nothing must say so, or an empty pane reads as a library that failed
    /// to load.
    @ViewBuilder
    private var searchResults: some View {
        let matchingLooks = editor.userLooks.filter {
            $0.name.localizedCaseInsensitiveContains(query)
        }
        let matchingStocks = FilmStock.allStocks.filter(matchesQuery)

        if matchingLooks.isEmpty, matchingStocks.isEmpty {
            VStack(spacing: 6) {
                Text("No looks match “\(query)”")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                Text("Try a stock, a look, or a category")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 28)
        } else {
            if !matchingLooks.isEmpty {
                InspectorCard(
                    title: "My Looks",
                    id: "looks.user.results",
                    editor: editor
                ) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(matchingLooks) { look in
                            UserLookRow(
                                look: look,
                                isActive: look.matches(editor.state),
                                onApply: { editor.applyUserLook(look) },
                                onDelete: { editor.deleteUserLook(look) }
                            )
                        }
                    }
                }
            }

            if !matchingStocks.isEmpty {
                InspectorCard(
                    title: "Film Stocks",
                    id: "looks.stocks.results",
                    editor: editor
                ) {
                    VStack(spacing: 1) {
                        ForEach(matchingStocks) { stock in
                            LookRow(
                                stock: stock,
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
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
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

/// One saved grade in the My Looks list.
///
/// Separate from ``LookRow`` rather than shared with it: a stock is chosen
/// once and applied, a user look is also *managed* — it can be deleted, and
/// "is this the active grade" is a field comparison, not a remembered id.
struct UserLookRow: View {
    let look: UserLook
    let isActive: Bool
    let onApply: () -> Void
    let onDelete: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: onApply) {
            HStack(spacing: 9) {
                Text(look.name)
                    .font(.system(size: 12, weight: isActive ? .semibold : .regular))
                    .lineLimit(1)

                Spacer(minLength: 4)

                if isActive {
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
                        isActive ? Color.accentColor.opacity(0.14)
                            : isHovering ? Color.primary.opacity(0.06)
                            : Color.clear
                    )
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .contextMenu {
            Button("Delete", role: .destructive, action: onDelete)
        }
        .accessibilityLabel(look.name)
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
    }
}

/// The Looks tab's search field, pinned above the list by the inspector.
///
/// Custom rather than `.searchable`: on macOS the system modifier places its
/// field in the window toolbar, away from the panel it filters, and a query
/// box belongs with the list it narrows — the same place Find My keeps its
/// search, directly over the results.
struct LookSearchField: View {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)

            TextField("Search looks", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .focused(isFocused)

            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color.white.opacity(0.06))
        }
        .accessibilityLabel("Search looks")
    }
}

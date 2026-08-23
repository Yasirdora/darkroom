public import SwiftUI
import DarkroomCore
import DarkroomRender

/// The controls, down the right-hand side.
///
/// Dark and opaque, for the same reason the canvas surround is: it sits beside
/// the image, and a light or translucent panel next to a photograph changes how
/// that photograph reads. Every grading application converges on this for the
/// same reason, and it is not a stylistic preference.
public struct InspectorView: View {

    @Bindable public var editor: Editor

    /// What the last automatic white balance rested on, so the pane can say
    /// when a correction came from very little of the frame.
    @State private var whiteBalanceEstimate: NeutralSampler.Estimate?

    /// Ties the selected tab's lit surface to one identity, so it travels
    /// between tabs rather than cutting.
    @Namespace private var tabSelection

    /// The Looks tab's query, held here so the field can stay pinned above
    /// the scrolling list — a search field that scrolls away is a search
    /// field you stop using.
    @State private var lookSearch = ""

    /// Focus for that field, driven by the Find Look menu command.
    @FocusState private var lookSearchFocused: Bool

    public init(editor: Editor) {
        self.editor = editor
    }

    public var body: some View {
        VStack(spacing: 0) {
            header

            if editor.inspectorTab == .looks {
                LookSearchField(text: $lookSearch, isFocused: $lookSearchFocused)
                    .padding(.horizontal, InspectorGeometry.panelInset)
                    .padding(.bottom, 8)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    switch editor.inspectorTab {
                    case .adjust: adjustments
                    case .curves: CurveEditor(editor: editor)
                    case .looks: LookPicker(editor: editor, searchText: lookSearch)
                    case .scopes: ScopePanel(editor: editor)
                    }
                }
                .padding(.vertical, 12)
            }
            .scrollIndicators(.automatic)
            // Content dissolves as it passes under the tabs instead of being
            // cut by a rule. The rule was the last thing in this panel that
            // looked drawn on rather than lit.
            .inspectorScrollEdge()

            resetButton
            footer
        }
        .frame(width: InspectorGeometry.panelWidth)
        // One floating surface, inset from the window's edges, rather than a
        // column butted against the right-hand side. The gap is the point: it
        // is what makes the panel read as sitting *above* the work instead of
        // being bolted to it.
        .inspectorPanel()
        .environment(\.colorScheme, .dark)
        // On the panel rather than on the field: the Find Look command stamps
        // its token in the same transaction that switches the tab, and an
        // observer living on the field would attach after the change it is
        // meant to see. The runloop hop then lets the field appear before it
        // is asked to take focus.
        .onChange(of: editor.lookSearchRequest) { _, _ in
            DispatchQueue.main.async { lookSearchFocused = true }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 2) {
            ForEach(Editor.InspectorTab.allCases) { tab in
                let isSelected = editor.inspectorTab == tab
                Button {
                    // Glass morphs between shapes when the change is animated
                    // and the shapes share an identity. Without this the
                    // selection cuts from one tab to the next; with it the lit
                    // surface travels, which is how the eye follows a selection
                    // rather than re-finding it.
                    withAnimation(.snappy(duration: 0.28, extraBounce: 0.05)) {
                        editor.inspectorTab = tab
                    }
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: tab.symbol)
                            .font(.system(size: 13))
                            .symbolVariant(isSelected ? .fill : .none)
                        Text(tab.title).font(.system(size: 10, weight: .medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(isSelected ? Color.accentColor : .secondary)
                .background {
                    if isSelected {
                        TabSelection(namespace: tabSelection)
                    }
                }
                .accessibilityLabel(tab.title)
                .accessibilityAddTraits(isSelected ? [.isSelected] : [])
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    // MARK: - Adjustments

    private var adjustments: some View {
        GlassPaneStack {
            InspectorCard(title: "Source", id: "source", editor: editor) {
                InputProfileSection(editor: editor)
            }

            ForEach(Adjustments.Key.Group.allCases) { group in
                InspectorCard(
                    title: group.title,
                    id: "adjust.\(group.id)",
                    editor: editor,
                    reset: { editor.resetGroup(group) },
                    isModified: !editor.isGroupNeutral(group),
                    accessory: {
                        if group == .whiteBalance {
                            AutoWhiteBalanceButton(
                                editor: editor,
                                estimate: $whiteBalanceEstimate
                            )
                        }
                    }
                ) {
                    VStack(spacing: 14) {
                        ForEach(group.keys) { key in
                            AdjustmentSlider(
                                key: key,
                                value: Binding(
                                    get: { editor.state.adjustments[key] },
                                    set: { newValue in
                                        editor.beginInteraction(label: key.title)
                                        editor.preview { $0.adjustments[key] = newValue }
                                    }
                                ),
                                onCommit: { editor.endInteraction() }
                            )
                        }

                        // Below the sliders, not above them. A caveat that
                        // appears after pressing Auto would otherwise shove the
                        // two controls it is about further down the pane, so
                        // reading it would mean losing sight of them.
                        if group == .whiteBalance {
                            WhiteBalanceNote(estimate: whiteBalanceEstimate)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, InspectorGeometry.panelInset)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 10) {
            if let size = editor.hasImage ? editor.pixelSize : nil {
                Text("\(Int(size.width)) × \(Int(size.height))")
                    .font(.system(size: 10, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }

            if editor.isRAW {
                Text("RAW")
                    .font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.18), in: Capsule())
                    .foregroundStyle(Color.accentColor)
            }

            Spacer()
        }
        .padding(.horizontal, InspectorGeometry.panelInset + 6)
        .padding(.top, 4)
        .padding(.bottom, 8)
    }

    /// Starting over, as a control rather than a word in a corner.
    ///
    /// It was an eleven-point label tucked at the edge — findable if you knew
    /// it was there, invisible if you did not. The action deserves the width:
    /// it is the one thing in the panel someone reaches for when they have
    /// lost the thread, which is exactly when hunting for a small grey word is
    /// least welcome.
    private var resetButton: some View {
        Button {
            editor.resetGrade()
        } label: {
            Text("Reset Adjustments")
                .font(.system(size: 11, weight: .medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(editor.state.isNeutral ? .tertiary : .secondary)
        .background {
            RoundedRectangle(cornerRadius: InspectorGeometry.paneRadius, style: .continuous)
                .fill(Color.white.opacity(0.055))
        }
        .disabled(editor.state.isNeutral)
        .padding(.horizontal, InspectorGeometry.panelInset)
        .padding(.bottom, InspectorGeometry.panelInset)
    }
}

/// How the file is read — the stage before the grade.
struct InputProfileSection: View {
    @Bindable var editor: Editor

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            VStack(alignment: .leading, spacing: 4) {
                Picker("", selection: Binding(
                    get: { editor.state.inputProfile },
                    set: { profile in
                        editor.update({ $0.inputProfile = profile }, label: "Input Profile")
                    }
                )) {
                    ForEach(InputProfile.Group.allCases, id: \.self) { group in
                        Section(group.title) {
                            ForEach(InputProfile.ordered.filter { $0.group == group }) { profile in
                                Text(profile.title).tag(profile)
                            }
                        }
                    }
                }
                .labelsHidden()
                .controlSize(.small)

                // The summary earns its space: "Sony FX-series and Venice" tells
                // someone whether they have picked the right one far faster than
                // the name alone does.
                Text(editor.state.inputProfile.summary)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

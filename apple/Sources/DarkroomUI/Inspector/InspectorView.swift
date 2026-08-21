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

    public init(editor: Editor) {
        self.editor = editor
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider().opacity(0.4)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    switch editor.inspectorTab {
                    case .adjust: adjustments
                    case .curves: CurveEditor(editor: editor)
                    case .looks: LookPicker(editor: editor)
                    case .scopes: ScopePanel(editor: editor)
                    }
                }
                .padding(.vertical, 12)
            }
            .scrollIndicators(.automatic)

            Divider().opacity(0.4)
            footer
        }
        .frame(width: 290)
        .background {
            // Vibrancy from behind the *window*, not from the photograph.
            // Sampling the image would tint the panel with whatever is on the
            // canvas and shift it as the grade changed, and colour is judged
            // against everything in view — which is the same reason the canvas
            // surround is a flat neutral.
            ZStack {
                VisualEffectBackground(material: .sidebar, blending: .behindWindow)
                // Held dark and neutral over the vibrancy. A bright desktop
                // would otherwise lighten the panel beside the photograph, and
                // the surround has to stay put to be worth anything.
                Color(red: 0.055, green: 0.055, blue: 0.062).opacity(0.72)
            }
            .ignoresSafeArea()
        }
        .environment(\.colorScheme, .dark)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 2) {
            ForEach(Editor.InspectorTab.allCases) { tab in
                Button {
                    editor.inspectorTab = tab
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: tab.symbol).font(.system(size: 13))
                        Text(tab.title).font(.system(size: 10, weight: .medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(editor.inspectorTab == tab ? Color.accentColor : .secondary)
                .background {
                    if editor.inspectorTab == tab {
                        RoundedRectangle(cornerRadius: 6)
                            .fill(Color.accentColor.opacity(0.12))
                    }
                }
                .accessibilityLabel(tab.title)
                .accessibilityAddTraits(editor.inspectorTab == tab ? [.isSelected] : [])
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    // MARK: - Adjustments

    private var adjustments: some View {
        VStack(alignment: .leading, spacing: 10) {
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
                        if group == .whiteBalance {
                            WhiteBalanceNote(estimate: whiteBalanceEstimate)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

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
                    }
                }
            }
        }
        .padding(.horizontal, 10)
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

            Button("Reset") { editor.resetGrade() }
                .font(.system(size: 11))
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                // `.plain` makes the hit region the drawn glyphs, so without
                // this only the letter strokes themselves are clickable.
                .padding(.horizontal, 4)
                .padding(.vertical, 2)
                .contentShape(Rectangle())
                .disabled(editor.state.isNeutral)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
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

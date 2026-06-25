import SwiftUI

/// First-run disclosure + consent, shown before any user text is sent to a third-party AI service.
///
/// App Store Guidelines 5.1.1(i) / 5.1.2(i): the app must disclose WHAT data is sent and to WHOM,
/// and obtain the user's permission BEFORE sharing it — and this must happen IN THE APP (a privacy
/// policy alone is not sufficient). `ChatViewModel.ensureConsent` gates every AI call on this.
struct AIConsentView: View {
    var onAgree: () -> Void
    var onDecline: () -> Void
    @Environment(\.openURL) private var openURL

    private let privacyURL = URL(string: "https://planfect-support-production.up.railway.app/privacy")!

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 12) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 30, weight: .bold))
                            .foregroundStyle(LinearGradient(colors: [.accentColor, .purple],
                                                            startPoint: .topLeading, endPoint: .bottomTrailing))
                        Text(String(localized: "How Planfect uses AI"))
                            .font(.system(.title2, design: .rounded).weight(.bold))
                        Text(String(localized: "To turn what you type into a schedule, Planfect sends your request to a third-party AI service for processing. Here's exactly what that means."))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 18) {
                        infoRow(icon: "paperplane.fill",
                                title: String(localized: "What we send"),
                                detail: String(localized: "Your chat messages, plus the task, routine, and schedule details needed to plan them. Addresses you enter for travel times are sent to Google Maps."))
                        infoRow(icon: "building.2.fill",
                                title: String(localized: "Who it goes to"),
                                detail: String(localized: "A third-party AI provider — OpenAI, or MiniMax for users in mainland China — which processes your request to generate a plan."))
                        infoRow(icon: "hand.raised.fill",
                                title: String(localized: "What we never do"),
                                detail: String(localized: "We don't use your data for advertising or cross-app tracking, and we never sell it."))
                    }

                    Button {
                        openURL(privacyURL)
                    } label: {
                        Text(String(localized: "Read our Privacy Policy"))
                            .font(.callout.weight(.semibold))
                    }
                }
                .padding(24)
            }

            VStack(spacing: 10) {
                Button(action: onAgree) {
                    Text(String(localized: "Agree & Continue"))
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Button(action: onDecline) {
                    Text(String(localized: "Not now"))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 20)
            .background(.bar)
        }
        .presentationDragIndicator(.hidden)
    }

    private func infoRow(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(.subheadline, design: .rounded).weight(.semibold))
                Text(detail).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}

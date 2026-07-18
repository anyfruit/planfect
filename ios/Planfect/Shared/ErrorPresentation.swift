import Foundation

extension Error {
    /// True when this error only means the work was cancelled — the view went away, a newer
    /// `.task(id:)` superseded this run, or the user backed out. In a Chinese locale the raw
    /// localizedDescription is just "已取消", which reads like a real failure but isn't one.
    var isCancellation: Bool {
        if self is CancellationError { return true }
        let ns = self as NSError
        if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled { return true }
        if ns.domain == NSCocoaErrorDomain, ns.code == NSUserCancelledError { return true }
        return false
    }

    /// Message for an error alert, or nil when the error shouldn't surface (cancellation).
    /// Alerts here are driven by `@State var error: String?`, so assigning nil shows nothing.
    var uiMessage: String? { isCancellation ? nil : localizedDescription }
}

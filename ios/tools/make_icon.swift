// Generates the Planfect app icon (1024×1024 PNG): a white "sparkles" mark on the brand
// blue→purple gradient, matching the in-app BotAvatar. Run: swift make_icon.swift <out.png>
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let S: CGFloat = 1024
let cs = CGColorSpaceCreateDeviceRGB()
let ctx = CGContext(data: nil, width: Int(S), height: Int(S), bitsPerComponent: 8,
                    bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(colorSpace: cs, components: [r, g, b, a])!
}

// Background: diagonal blue → indigo → purple (top-left to bottom-right).
let grad = CGGradient(colorsSpace: cs,
                      colors: [color(0.22, 0.45, 1.00), color(0.46, 0.36, 0.98), color(0.72, 0.32, 0.92)] as CFArray,
                      locations: [0, 0.5, 1])!
ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: S), end: CGPoint(x: S, y: 0), options: [])

// Soft sheen for depth.
let sheen = CGGradient(colorsSpace: cs, colors: [color(1, 1, 1, 0.18), color(1, 1, 1, 0)] as CFArray, locations: [0, 1])!
ctx.drawRadialGradient(sheen, startCenter: CGPoint(x: S * 0.34, y: S * 0.72), startRadius: 0,
                       endCenter: CGPoint(x: S * 0.34, y: S * 0.72), endRadius: S * 0.62, options: [])

// A 4-point sparkle (concave star) centered at (cx,cy).
func sparkle(_ cx: CGFloat, _ cy: CGFloat, _ R: CGFloat, _ inner: CGFloat) -> CGPath {
    func P(_ deg: CGFloat, _ rad: CGFloat) -> CGPoint {
        let a = deg * .pi / 180
        return CGPoint(x: cx + cos(a) * rad, y: cy + sin(a) * rad)
    }
    let r = R * inner
    let p = CGMutablePath()
    p.move(to: P(90, R))
    p.addQuadCurve(to: P(180, R), control: P(135, r))
    p.addQuadCurve(to: P(270, R), control: P(225, r))
    p.addQuadCurve(to: P(0,   R), control: P(315, r))
    p.addQuadCurve(to: P(90,  R), control: P(45,  r))
    p.closeSubpath()
    return p
}

ctx.setFillColor(color(1, 1, 1))

// Big sparkle with a soft drop shadow.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 38, color: color(0, 0, 0, 0.20))
ctx.addPath(sparkle(S * 0.50, S * 0.475, S * 0.285, 0.16))
ctx.fillPath()
ctx.restoreGState()

// Two small companions → the "sparkles" feel.
ctx.addPath(sparkle(S * 0.745, S * 0.72, S * 0.115, 0.17)); ctx.fillPath()
ctx.addPath(sparkle(S * 0.30,  S * 0.28, S * 0.085, 0.17)); ctx.fillPath()

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
CGImageDestinationFinalize(dest)
print("wrote \(out)")

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let space = CGColorSpaceCreateDeviceRGB()
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
    bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 8 / 255, green: 11 / 255, blue: 13 / 255, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: size, height: size))

func bar(_ start: CGFloat, _ end: CGFloat, color: CGColor) {
    context.setLineWidth(112)
    context.setLineCap(.round)
    context.setStrokeColor(color)
    context.move(to: CGPoint(x: start, y: 512))
    context.addLine(to: CGPoint(x: end, y: 512))
    context.strokePath()
}
bar(150, 455, color: CGColor(red: 246 / 255, green: 92 / 255, blue: 92 / 255, alpha: 1))
bar(569, 874, color: CGColor(red: 46 / 255, green: 217 / 255, blue: 128 / 255, alpha: 1))

let output = URL(fileURLWithPath: CommandLine.arguments[1])
let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("No se pudo generar el icono") }

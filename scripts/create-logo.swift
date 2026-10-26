import AppKit
import CoreText

let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("assets/brand")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let baseFont = CTFontCreateWithName("Kefa" as CFString, 1000, nil)
let font = CTFontCreateForString(baseFont, "ዠ" as CFString, CFRange(location: 0, length: 1))
var character: UniChar = 0x12E0
var glyph: CGGlyph = 0
guard CTFontGetGlyphsForCharacters(font, &character, &glyph, 1),
      let outline = CTFontCreatePathForGlyph(font, glyph, nil)
else {
  fatalError("The local Kefa font must contain Ethiopic character U+12E0")
}

let bounds = outline.boundingBoxOfPath
let scale = 740 / max(bounds.width, bounds.height)
let offsetX = (1024 - bounds.width * scale) / 2 - bounds.minX * scale
let offsetY = (1024 - bounds.height * scale) / 2 - bounds.minY * scale
var commands: [String] = []
func point(_ value: CGPoint) -> String { "\(value.x) \(value.y)" }
outline.applyWithBlock { pointer in
  let element = pointer.pointee
  switch element.type {
  case .moveToPoint: commands.append("M\(point(element.points[0]))")
  case .addLineToPoint: commands.append("L\(point(element.points[0]))")
  case .addQuadCurveToPoint: commands.append("Q\(point(element.points[0])) \(point(element.points[1]))")
  case .addCurveToPoint: commands.append("C\(point(element.points[0])) \(point(element.points[1])) \(point(element.points[2]))")
  case .closeSubpath: commands.append("Z")
  @unknown default: fatalError("Unsupported path element")
  }
}

for (name, luminous, violet) in [("zebgen-mark", false, false), ("zebgen-mark-luminous", true, false), ("zebgen-mark-violet", false, true)] {
  let fill = violet ? "#be9dff" : "#e2d2ff"
  let path = "<path fill=\"\(fill)\" transform=\"translate(\(offsetX) \(1024 - offsetY)) scale(\(scale) -\(scale))\" d=\"\(commands.joined(separator: " "))\"/>"
  let filter = luminous ? "<defs><filter id=\"glow\" x=\"-40%\" y=\"-40%\" width=\"180%\" height=\"180%\"><feDropShadow dx=\"0\" dy=\"0\" stdDeviation=\"18\" flood-color=\"#a786ff\" flood-opacity=\"0.5\"/></filter></defs>" : ""
  let group = luminous ? "<g filter=\"url(#glow)\">\(path)</g>" : path
  let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1024 1024\" role=\"img\" aria-label=\"zebgen logo: Ethiopic character ዠ\"><title>zebgen</title>\(filter)\(group)</svg>"
  try svg.write(to: output.appendingPathComponent("\(name).svg"), atomically: true, encoding: .utf8)
  for size in [16, 32, 48, 96, 128, 256, 512, 1024] {
    let pixels = CGFloat(size)
    guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("Cannot create bitmap") }
    context.scaleBy(x: pixels / 1024, y: pixels / 1024)
    if luminous { context.setShadow(offset: .zero, blur: 36, color: CGColor(red: 167 / 255, green: 134 / 255, blue: 1, alpha: 0.5)) }
    context.translateBy(x: offsetX, y: offsetY)
    context.scaleBy(x: scale, y: scale)
    context.addPath(outline)
    context.setFillColor(CGColor(red: violet ? 190 / 255 : 226 / 255, green: violet ? 157 / 255 : 210 / 255, blue: 1, alpha: 1))
    context.fillPath()
    guard let image = context.makeImage(), let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { fatalError("Cannot encode PNG") }
    try data.write(to: output.appendingPathComponent("\(name)-\(size).png"))
  }
}

print("Created outlined SVGs and transparent PNGs in assets/brand")

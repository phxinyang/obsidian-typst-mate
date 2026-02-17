use std::fmt::Write;
use typst::layout::{Frame, FrameItem, Transform};
use typst::text::TextItem;

/// Generate invisible text layer SVG for Frame
pub fn generate_text_layer_for_frame(frame: &Frame) -> String {
    let mut buffer = String::new();
    render_frame(&mut buffer, frame);
    buffer
}

/// Recursively traverse Frame and generate text SVG elements
fn render_frame(buffer: &mut String, frame: &Frame) {
    for (pos, item) in frame.items() {
        match item {
            FrameItem::Group(group) => {
                let ts = group.transform;
                let translate = Transform::translate(pos.x, pos.y);
                let combined = translate.pre_concat(ts);

                write!(
                    buffer,
                    r#"<g transform="matrix({},{},{},{},{},{})">"#,
                    combined.sx.get(),
                    combined.ky.get(),
                    combined.kx.get(),
                    combined.sy.get(),
                    combined.tx.to_pt(),
                    combined.ty.to_pt()
                )
                .unwrap();

                render_frame(buffer, &group.frame);
                write!(buffer, "</g>").unwrap();
            }
            FrameItem::Text(text) => {
                let translate = Transform::translate(pos.x, pos.y);
                let flip_y = Transform::scale(
                    typst::layout::Ratio::one(),
                    -typst::layout::Ratio::one(),
                );
                let combined = translate.pre_concat(flip_y);

                write!(
                    buffer,
                    r#"<g transform="matrix({},{},{},{},{},{})">"#,
                    combined.sx.get(),
                    combined.ky.get(),
                    combined.kx.get(),
                    combined.sy.get(),
                    combined.tx.to_pt(),
                    combined.ty.to_pt()
                )
                .unwrap();

                render_text_item(buffer, text);
                write!(buffer, "</g>").unwrap();
            }
            _ => {}
        }
    }
}

/// Render text item glyphs - all glyphs in one <text> element for proper selection
fn render_text_item(xml: &mut String, text: &TextItem) {
    let mut x = 0.0;
    let mut y = 0.0;
    let font_size = text.size.to_pt();

    write!(
        xml,
        r#"<text fill="transparent" font-size="{}pt" style="font-variant-ligatures: none" dominant-baseline="alphabetic">"#,
        font_size
    )
    .unwrap();

    for glyph in &text.glyphs {
        let g_x = x + glyph.x_offset.at(text.size).to_pt();
        let g_y = y + glyph.y_offset.at(text.size).to_pt();
        let x_advance = glyph.x_advance.at(text.size).to_pt();

        let raw_text = &text.text.as_str()[glyph.range()];
        let escaped_text = raw_text
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;");

        if x_advance > 0.001 {
            write!(
                xml,
                r#"<tspan x="{}" y="{}" dx="0" textLength="{}" lengthAdjust="spacingAndGlyphs" style="user-select: all">{}</tspan>"#,
                g_x, g_y, x_advance, escaped_text
            )
            .unwrap();
        } else {
            write!(
                xml,
                r#"<tspan x="{}" y="{}" dx="0" style="user-select: all">{}</tspan>"#,
                g_x, g_y, escaped_text
            )
            .unwrap();
        }

        x += x_advance;
        y += glyph.y_advance.at(text.size).to_pt();
    }

    xml.push_str("</text>");
}

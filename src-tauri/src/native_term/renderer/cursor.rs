// R1.d-γ: minimal wgpu pipeline for drawing the cursor bar.
//
// A single solid-color quad positioned at the cursor's pixel rect. Per-cell
// background and decoration quads are handled by the sibling
// `quad_pipeline.rs` (instanced); we keep the cursor on its simpler
// single-uniform path because it only ever draws one quad per frame.

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

/// Cursor visual style. Mirrors the xterm.js `cursorStyle` option set:
///   - `Bar`       — 2px-wide vertical line at the cursor x. Default.
///   - `Block`     — full cell-rect tinted quad. Drawn AFTER the glyph pass at
///                   reduced alpha so the cell character remains visible
///                   underneath (true xterm "inverse" requires re-rendering
///                   the glyph in the bg color, which would require an extra
///                   glyphon pass — deferred to a future slice).
///   - `Underline` — full cell-width horizontal bar at the cell bottom.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorStyle {
    Bar,
    Block,
    Underline,
}

impl CursorStyle {
    pub fn parse(s: &str) -> Self {
        match s {
            "block" => CursorStyle::Block,
            "underline" => CursorStyle::Underline,
            _ => CursorStyle::Bar,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CursorUniform {
    /// Top-left x, y in surface pixels.
    pub rect_x: f32,
    pub rect_y: f32,
    /// Width, height in surface pixels.
    pub rect_w: f32,
    pub rect_h: f32,
    /// Surface dimensions in pixels. Used to project pixel coords → NDC.
    pub surface_w: f32,
    pub surface_h: f32,
    pub _pad0: [f32; 2],
    /// RGBA in 0..1.
    pub color: [f32; 4],
}

pub struct CursorPipeline {
    pipeline: wgpu::RenderPipeline,
    uniform_buf: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

const SHADER_SRC: &str = r#"
struct U {
  rect: vec4<f32>,   // x, y, w, h
  surface: vec4<f32>, // w, h, pad, pad
  color: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: U;

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
  );
  let p = positions[vid];
  let px = u.rect.x + p.x * u.rect.z;
  let py = u.rect.y + p.y * u.rect.w;
  let ndc_x = (px / u.surface.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (py / u.surface.y) * 2.0;
  return vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return u.color;
}
"#;

impl CursorPipeline {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("native_term cursor shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER_SRC.into()),
        });

        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("native_term cursor uniforms"),
            contents: bytemuck::bytes_of(&CursorUniform {
                rect_x: 0.0,
                rect_y: 0.0,
                rect_w: 0.0,
                rect_h: 0.0,
                surface_w: 1.0,
                surface_h: 1.0,
                _pad0: [0.0; 2],
                color: [1.0, 1.0, 1.0, 1.0],
            }),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("native_term cursor bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("native_term cursor bg"),
            layout: &bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buf.as_entire_binding(),
            }],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("native_term cursor layout"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("native_term cursor pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_main",
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_main",
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self {
            pipeline,
            uniform_buf,
            bind_group,
        }
    }

    /// Update the uniform and draw a single 6-vertex quad. Coordinates are
    /// surface-pixel space; the shader projects to NDC.
    pub fn draw<'pass>(
        &'pass self,
        queue: &wgpu::Queue,
        surface_w: f32,
        surface_h: f32,
        rect_x: f32,
        rect_y: f32,
        rect_w: f32,
        rect_h: f32,
        color: [f32; 4],
        pass: &mut wgpu::RenderPass<'pass>,
    ) {
        let u = CursorUniform {
            rect_x,
            rect_y,
            rect_w,
            rect_h,
            surface_w,
            surface_h,
            _pad0: [0.0; 2],
            color,
        };
        queue.write_buffer(&self.uniform_buf, 0, bytemuck::bytes_of(&u));
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.draw(0..6, 0..1);
    }
}

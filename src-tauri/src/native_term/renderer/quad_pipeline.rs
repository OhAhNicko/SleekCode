// Instanced solid-color quad pipeline.
//
// R1.d-δ: per-cell background quads + decoration (underline/strikeout) bars
// share this one pipeline. Each draw call issues a single 6-vertex triangle
// strip per instance. The vertex shader projects pixel-space rects to NDC
// using a small uniform that holds the current surface size.
//
// The cursor still uses `cursor.rs` (single-uniform path) since it's cheap
// and we keep the existing one-quad shader free of instance plumbing.

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

/// One instance = one screen-aligned, opaque-colored quad.
///
/// Field layout matches the WGSL `Instance` struct below; do not reorder
/// without updating `vertex_attr_array` and the shader.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
pub struct QuadInstance {
    /// Top-left x, y, width, height in surface pixels.
    pub rect: [f32; 4],
    /// Linear RGBA in 0..1 (the shader writes color straight to the target;
    /// gamma is handled by the surface format choice in pipeline.rs).
    pub color: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct SurfaceUniform {
    /// Surface w, h in pixels; pad to vec4 for std140-style alignment.
    surface: [f32; 4],
}

pub struct QuadPipeline {
    pipeline: wgpu::RenderPipeline,
    uniform_buf: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    /// Growable instance buffer. Resized (recreated) when the per-frame
    /// instance count exceeds `capacity`.
    instance_buf: wgpu::Buffer,
    capacity: usize,
    /// Number of instances currently uploaded for the active frame.
    /// Set by `upload`, consumed by `draw`.
    pending: u32,
}

const INITIAL_CAPACITY: usize = 256;

const SHADER_SRC: &str = r#"
struct U {
  surface: vec4<f32>, // w, h, pad, pad
};
@group(0) @binding(0) var<uniform> u: U;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vid: u32,
  @location(0) rect: vec4<f32>,
  @location(1) color: vec4<f32>,
) -> VsOut {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
  );
  let p = positions[vid];
  let px = rect.x + p.x * rect.z;
  let py = rect.y + p.y * rect.w;
  let ndc_x = (px / u.surface.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (py / u.surface.y) * 2.0;
  var out: VsOut;
  out.pos = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return in.color;
}
"#;

impl QuadPipeline {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("native_term quad shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER_SRC.into()),
        });

        let uniform_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("native_term quad surface uniform"),
            contents: bytemuck::bytes_of(&SurfaceUniform {
                surface: [1.0, 1.0, 0.0, 0.0],
            }),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("native_term quad bgl"),
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
            label: Some("native_term quad bg"),
            layout: &bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buf.as_entire_binding(),
            }],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("native_term quad layout"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });

        // Instance buffer layout: rect (vec4) @ location 0, color (vec4) @ 1.
        let instance_attrs = wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4];
        let instance_buf_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<QuadInstance>() as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &instance_attrs,
        };

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("native_term quad pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_main",
                compilation_options: Default::default(),
                buffers: &[instance_buf_layout],
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

        let instance_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("native_term quad instances"),
            size: (std::mem::size_of::<QuadInstance>() * INITIAL_CAPACITY) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self {
            pipeline,
            uniform_buf,
            bind_group,
            instance_buf,
            capacity: INITIAL_CAPACITY,
            pending: 0,
        }
    }

    /// Upload instance data + refresh the surface uniform. Grows the instance
    /// buffer if needed (recreate, not COPY_SRC, since we always rewrite the
    /// whole frame's worth). Stores instance count for the upcoming `draw`.
    pub fn upload(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        surface_w: f32,
        surface_h: f32,
        instances: &[QuadInstance],
    ) {
        queue.write_buffer(
            &self.uniform_buf,
            0,
            bytemuck::bytes_of(&SurfaceUniform {
                surface: [surface_w, surface_h, 0.0, 0.0],
            }),
        );
        if instances.is_empty() {
            self.pending = 0;
            return;
        }
        if instances.len() > self.capacity {
            // Geometric growth so we don't reallocate every grid resize.
            let new_cap = (instances.len() * 2).max(INITIAL_CAPACITY);
            self.instance_buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("native_term quad instances"),
                size: (std::mem::size_of::<QuadInstance>() * new_cap) as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.capacity = new_cap;
        }
        queue.write_buffer(&self.instance_buf, 0, bytemuck::cast_slice(instances));
        self.pending = instances.len() as u32;
    }

    /// Draw the most-recently-uploaded set of instances. No-op if zero.
    pub fn draw<'pass>(&'pass self, pass: &mut wgpu::RenderPass<'pass>) {
        if self.pending == 0 {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.set_vertex_buffer(0, self.instance_buf.slice(..));
        pass.draw(0..6, 0..self.pending);
    }
}

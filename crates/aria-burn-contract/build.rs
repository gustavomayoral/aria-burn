// SPDX-License-Identifier: GPL-3.0-or-later
//! Generates the contract types from aria-burn-core, the single source of truth:
//! - `contract.rs`: serde types from `contract.schema.json`, via typify.
//! - `sample_batch.rs`: the binary sample-batch header/sample structs and codec,
//!   from `sample-batch-layout.json`.
//!
//! Nothing here is hand-written per type; change the TypeBox sources in the core,
//! run `pnpm contract:export` there, and this crate follows on the next build.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use proc_macro2::{Ident, Span, TokenStream};
use quote::quote;
use serde_json::Value;
use typify::{TypeSpace, TypeSpaceSettings};

fn core_dir() -> PathBuf {
    println!("cargo:rerun-if-env-changed=ARIA_BURN_CORE_DIR");
    let dir = match env::var_os("ARIA_BURN_CORE_DIR") {
        Some(dir) => PathBuf::from(dir),
        // crates/aria-burn-contract → repo root → sibling checkout
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../aria-burn-core"),
    };
    dir.canonicalize().unwrap_or_else(|_| {
        panic!(
            "aria-burn-core not found at {}. Check it out next to aria-burn or set ARIA_BURN_CORE_DIR.",
            dir.display()
        )
    })
}

fn main() {
    let core = core_dir();
    let contract = core.join("src/contract");
    let schema_path = contract.join("schema/contract.schema.json");
    let layout_path = contract.join("schema/sample-batch-layout.json");
    println!("cargo:rerun-if-changed={}", schema_path.display());
    println!("cargo:rerun-if-changed={}", layout_path.display());
    // Tests read the fixtures from the same checkout the types came from.
    println!("cargo:rustc-env=ARIA_BURN_CONTRACT_DIR={}", contract.display());

    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    fs::write(out.join("contract.rs"), generate_contract(&schema_path)).unwrap();
    fs::write(out.join("sample_batch.rs"), generate_sample_batch(&layout_path)).unwrap();
}

fn pretty(tokens: TokenStream) -> String {
    prettyplease::unparse(&syn::parse2(tokens).expect("generated code parses"))
}

fn generate_contract(schema_path: &Path) -> String {
    let text = fs::read_to_string(schema_path).unwrap();
    let mut schema: Value = serde_json::from_str(&text).unwrap();
    // schemars 0.8 (what typify reads) knows `definitions` and `#/definitions/` refs;
    // the core emits draft 2020-12 `$defs`. Same meaning, so rename on the way in.
    let obj = schema.as_object_mut().unwrap();
    if let Some(defs) = obj.remove("$defs") {
        obj.insert("definitions".into(), defs);
    }
    const_to_enum(&mut schema);
    let schema: schemars::schema::RootSchema =
        serde_json::from_str(&serde_json::to_string(&schema).unwrap().replace("#/$defs/", "#/definitions/")).unwrap();

    let mut space = TypeSpace::new(TypeSpaceSettings::default().with_struct_builder(false));
    space.add_root_schema(schema).expect("typify accepts the contract schema");
    pretty(space.to_stream())
}

/// typify reads `{"const": "plan.done"}` as a plain `String`, which turns every
/// `type`/`kind`-discriminated union into an untagged enum that never checks the
/// tag. A single-value `enum` means the same thing in JSON Schema, and typify
/// recognises it as a tag, generating `#[serde(tag = "type")]` enums instead.
fn const_to_enum(v: &mut Value) {
    match v {
        Value::Object(map) => {
            if let Some(c) = map.remove("const") {
                map.insert("enum".into(), Value::Array(vec![c]));
            }
            map.values_mut().for_each(const_to_enum);
        }
        Value::Array(items) => items.iter_mut().for_each(const_to_enum),
        _ => {}
    }
}

struct Field {
    name: String,
    ty: String,
    offset: usize,
    description: String,
}

fn rust_ident(camel: &str) -> Ident {
    let mut snake = String::new();
    for (i, c) in camel.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                snake.push('_');
            }
            snake.push(c.to_ascii_lowercase());
        } else {
            snake.push(c);
        }
    }
    Ident::new(&snake, Span::call_site())
}

fn width(ty: &str) -> usize {
    match ty {
        "u16" => 2,
        "u32" | "f32" => 4,
        "f64" => 8,
        other => panic!("unsupported layout type {other}"),
    }
}

fn fields(list: &Value, with_offsets: bool) -> Vec<Field> {
    let mut offset = 0;
    list.as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let ty = f["type"].as_str().unwrap().to_owned();
            let at = if with_offsets { f["offset"].as_u64().unwrap() as usize } else { offset };
            offset = at + width(&ty);
            Field {
                name: f["name"].as_str().unwrap().to_owned(),
                description: f["description"].as_str().unwrap_or_default().to_owned(),
                ty,
                offset: at,
            }
        })
        .collect()
}

fn generate_sample_batch(layout_path: &Path) -> String {
    let layout: Value = serde_json::from_str(&fs::read_to_string(layout_path).unwrap()).unwrap();
    assert_eq!(layout["endianness"], "little", "codec assumes little-endian");
    let magic = layout["magic"].as_u64().unwrap() as u32;
    let version = layout["layoutVersion"].as_u64().unwrap() as u16;
    let header_bytes = layout["headerBytes"].as_u64().unwrap() as usize;
    let stride = layout["strideBytes"].as_u64().unwrap() as usize;
    let max_samples = layout["maxSamples"].as_u64().unwrap() as usize;
    let last_flag = layout["flags"]["last"].as_u64().unwrap() as u32;

    let header = fields(&layout["header"], true);
    let samples = fields(&layout["fields"], false);
    let sample_end = samples.last().map(|f| f.offset + width(&f.ty)).unwrap_or(0);
    assert_eq!(sample_end, stride, "sample fields must fill strideBytes exactly");

    // Header fields the codec fills itself; the rest are carried in SampleBatchHeader.
    let derived = ["magic", "layoutVersion", "strideBytes", "sampleCount", "flags"];
    let header_struct: Vec<_> = header.iter().filter(|f| !derived.contains(&f.name.as_str())).collect();

    let decl = |f: &Field| {
        let name = rust_ident(&f.name);
        let ty = Ident::new(&f.ty, Span::call_site());
        let doc = &f.description;
        quote! { #[doc = #doc] pub #name: #ty, }
    };
    let header_decls = header_struct.iter().map(|f| decl(f));
    let sample_decls = samples.iter().map(decl);

    let read = |f: &Field, base: TokenStream| {
        let ty = Ident::new(&f.ty, Span::call_site());
        let at = f.offset;
        let w = width(&f.ty);
        quote! { #ty::from_le_bytes(bytes[#base + #at..#base + #at + #w].try_into().unwrap()) }
    };
    let write = |f: &Field, value: TokenStream, base: TokenStream| {
        let at = f.offset;
        let w = width(&f.ty);
        quote! { out[#base + #at..#base + #at + #w].copy_from_slice(&(#value).to_le_bytes()); }
    };

    let header_field = |name: &str| header.iter().find(|f| f.name == name).unwrap();
    let h_write: Vec<_> = header
        .iter()
        .map(|f| {
            let value = match f.name.as_str() {
                "magic" => quote! { SAMPLE_BATCH_MAGIC },
                "layoutVersion" => quote! { SAMPLE_BATCH_LAYOUT_VERSION },
                "strideBytes" => quote! { SAMPLE_STRIDE_BYTES as u16 },
                "sampleCount" => quote! { samples.len() as u32 },
                "flags" => quote! { if header.last { SAMPLE_BATCH_FLAG_LAST } else { 0u32 } },
                _ => {
                    let n = rust_ident(&f.name);
                    quote! { header.#n }
                }
            };
            write(f, value, quote! { 0 })
        })
        .collect();
    let h_read: Vec<_> = header_struct
        .iter()
        .map(|f| {
            let n = rust_ident(&f.name);
            let r = read(f, quote! { 0 });
            quote! { #n: #r, }
        })
        .collect();
    let s_write: Vec<_> = samples
        .iter()
        .map(|f| {
            let n = rust_ident(&f.name);
            write(f, quote! { s.#n }, quote! { base })
        })
        .collect();
    let s_read: Vec<_> = samples
        .iter()
        .map(|f| {
            let n = rust_ident(&f.name);
            let r = read(f, quote! { base });
            quote! { #n: #r, }
        })
        .collect();
    let read_magic = read(header_field("magic"), quote! { 0 });
    let read_version = read(header_field("layoutVersion"), quote! { 0 });
    let read_stride = read(header_field("strideBytes"), quote! { 0 });
    let read_count = read(header_field("sampleCount"), quote! { 0 });
    let read_flags = read(header_field("flags"), quote! { 0 });

    pretty(quote! {
        pub const SAMPLE_BATCH_MAGIC: u32 = #magic;
        pub const SAMPLE_BATCH_LAYOUT_VERSION: u16 = #version;
        pub const SAMPLE_BATCH_HEADER_BYTES: usize = #header_bytes;
        pub const SAMPLE_STRIDE_BYTES: usize = #stride;
        pub const SAMPLE_BATCH_MAX_SAMPLES: usize = #max_samples;
        pub const SAMPLE_BATCH_FLAG_LAST: u32 = #last_flag;

        /// Batch header fields the producer chooses; magic, version, stride,
        /// count and flags are written by the codec.
        #[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct SampleBatchHeader {
            #(#header_decls)*
            /// Last batch of the job (flags bit 0).
            pub last: bool,
        }

        /// One planner motion sample.
        #[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct MotionSample {
            #(#sample_decls)*
        }

        #[derive(Debug, PartialEq, Eq)]
        pub enum SampleBatchError {
            TooShort,
            BadMagic(u32),
            BadVersion(u16),
            BadStride(u16),
            TooManySamples(usize),
            LengthMismatch { expected: usize, actual: usize },
            ReservedFlags(u32),
        }

        impl std::fmt::Display for SampleBatchError {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{self:?}")
            }
        }
        impl std::error::Error for SampleBatchError {}

        pub fn encoded_len(sample_count: usize) -> usize {
            SAMPLE_BATCH_HEADER_BYTES + sample_count * SAMPLE_STRIDE_BYTES
        }

        /// Encodes one batch. Panics if `samples` exceeds SAMPLE_BATCH_MAX_SAMPLES.
        pub fn encode_sample_batch(header: &SampleBatchHeader, samples: &[MotionSample]) -> Vec<u8> {
            let mut out = vec![0u8; encoded_len(samples.len())];
            encode_sample_batch_into(header, samples, &mut out);
            out
        }

        /// Encodes into a buffer of exactly `encoded_len(samples.len())` bytes.
        pub fn encode_sample_batch_into(header: &SampleBatchHeader, samples: &[MotionSample], out: &mut [u8]) {
            assert!(samples.len() <= SAMPLE_BATCH_MAX_SAMPLES, "too many samples in one batch");
            assert_eq!(out.len(), encoded_len(samples.len()));
            #(#h_write)*
            for (i, s) in samples.iter().enumerate() {
                let base = SAMPLE_BATCH_HEADER_BYTES + i * SAMPLE_STRIDE_BYTES;
                #(#s_write)*
            }
        }

        pub fn decode_sample_batch(bytes: &[u8]) -> Result<(SampleBatchHeader, Vec<MotionSample>), SampleBatchError> {
            if bytes.len() < SAMPLE_BATCH_HEADER_BYTES {
                return Err(SampleBatchError::TooShort);
            }
            let magic = #read_magic;
            if magic != SAMPLE_BATCH_MAGIC { return Err(SampleBatchError::BadMagic(magic)); }
            let version = #read_version;
            if version != SAMPLE_BATCH_LAYOUT_VERSION { return Err(SampleBatchError::BadVersion(version)); }
            let stride = #read_stride;
            if stride as usize != SAMPLE_STRIDE_BYTES { return Err(SampleBatchError::BadStride(stride)); }
            let count = #read_count as usize;
            if count > SAMPLE_BATCH_MAX_SAMPLES { return Err(SampleBatchError::TooManySamples(count)); }
            if bytes.len() != encoded_len(count) {
                return Err(SampleBatchError::LengthMismatch { expected: encoded_len(count), actual: bytes.len() });
            }
            let flags = #read_flags;
            if flags & !SAMPLE_BATCH_FLAG_LAST != 0 { return Err(SampleBatchError::ReservedFlags(flags)); }
            let header = SampleBatchHeader { #(#h_read)* last: flags & SAMPLE_BATCH_FLAG_LAST != 0 };
            let samples = (0..count)
                .map(|i| {
                    let base = SAMPLE_BATCH_HEADER_BYTES + i * SAMPLE_STRIDE_BYTES;
                    MotionSample { #(#s_read)* }
                })
                .collect();
            Ok((header, samples))
        }
    })
}

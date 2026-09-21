import type { LocalModelCatalogEntry } from '../../shared/local-llm-types'

/**
 * Curated, download-on-demand GGUF catalog. Sizes were verified against the
 * Hugging Face API. Nothing here is bundled with the app.
 *
 * The `id` is what pi sees in its model picker (via `.pi/models.json`).
 */
export const LOCAL_MODEL_CATALOG: LocalModelCatalogEntry[] = [
  {
    id: 'local/smollm2-360m-instruct',
    name: 'SmolLM2 360M (tiny, smoke test)',
    repo: 'bartowski/SmolLM2-360M-Instruct-GGUF',
    file: 'SmolLM2-360M-Instruct-Q4_K_M.gguf',
    quant: 'Q4_K_M',
    approxBytes: 271_000_000,
    defaultContext: 4096,
    minVramMb: 512,
    note: 'Very small and fast; limited reasoning and weak tool use.'
  },
  {
    id: 'local/qwen3.5-0.8b-instruct',
    name: 'Qwen3.5 0.8B Instruct',
    repo: 'unsloth/Qwen3.5-0.8B-GGUF',
    file: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    quant: 'Q4_K_M',
    approxBytes: 533_000_000,
    defaultContext: 8192,
    minVramMb: 1536,
    note: 'Recommended first model: small, tool-calling chat template.'
  },
  {
    id: 'local/qwen3-1.7b-instruct',
    name: 'Qwen3 1.7B Instruct',
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    quant: 'Q4_K_M',
    approxBytes: 1_107_000_000,
    defaultContext: 8192,
    minVramMb: 2560,
    note: 'Better reasoning; needs ~2.5 GB VRAM for a comfortable context.'
  },
  {
    id: 'local/llama-3.2-3b-instruct',
    name: 'Llama 3.2 3B Instruct',
    repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    quant: 'Q4_K_M',
    approxBytes: 2_019_000_000,
    defaultContext: 8192,
    minVramMb: 3584,
    note: 'Needs ~3.5 GB VRAM; best quality of the small set.'
  }
]

export function findCatalogEntry(id: string): LocalModelCatalogEntry | undefined {
  return LOCAL_MODEL_CATALOG.find((entry) => entry.id === id)
}

/** Direct download URL for a catalog entry (follows redirects). */
export function huggingFaceDownloadUrl(entry: LocalModelCatalogEntry): string {
  return `https://huggingface.co/${entry.repo}/resolve/main/${entry.file}?download=true`
}

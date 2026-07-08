import { createOpenAI, openai } from '@ai-sdk/openai'
import { LanguageModel } from 'ai'

import { checkAwsCredentials, createRoutedBedrock } from './bedrock'
import {
  BedrockModel,
  getDefaultModelForProvider,
  Model,
  OpenAIModelEntry,
  OpenAIModelId,
  ProviderModelConfig,
  PROVIDERS,
} from './model.utils'

type ProviderOptions = Record<string, any>
type SystemProviderOptions = Record<string, any>

type ModelSuccess = {
  /** Spread directly into AI SDK calls: `streamText({ ...modelParams, ... })` */
  modelParams: { model: LanguageModel; providerOptions?: ProviderOptions }
  systemProviderOptions?: SystemProviderOptions
  error?: never
}

export type ModelError = {
  modelParams?: never
  systemProviderOptions?: never
  error: Error
}

type ModelResponse = ModelSuccess | ModelError

export type GetModelParams =
  | {
      provider: 'openai'
      /**
       * Specifies which OpenAI model to use and its reasoning effort.
       * Create entries via `openaiModelEntry()` — reasoning effort is validated against the model
       * at compile time. Use `DEFAULT_COMPLETION_MODEL` for simple endpoints (minimal reasoning).
       * Callers are responsible for resolving the correct entry (including throttling/entitlement
       * fallbacks) before calling getModel.
       */
      modelEntry: OpenAIModelEntry
    }
  | {
      provider: 'bedrock'
      /** Used for consistent hashing across Bedrock regions. */
      routingKey: string
    }

/**
 * Retrieves a LanguageModel from a specific provider and model entry.
 * Callers are responsible for resolving the correct model entry (including throttling/entitlement
 * fallbacks) before calling this function.
 * Returns systemProviderOptions that callers can attach to the system message.
 */
export async function getModel(params: GetModelParams): Promise<ModelResponse> {
  const { provider } = params

  const providerRegistry = PROVIDERS[provider]
  if (!providerRegistry) {
    return { error: new Error(`Unknown provider: ${provider}`) }
  }

  const models = providerRegistry.models as Record<Model, ProviderModelConfig>
  const modelEntry = params.provider === 'openai' ? params.modelEntry : undefined

  const useDefault = !modelEntry?.id || !models[modelEntry.id]

  const chosenModelId = useDefault ? getDefaultModelForProvider(provider) : modelEntry?.id

  if (provider === 'bedrock') {
    const hasAwsCredentials = await checkAwsCredentials()
    const hasAwsBedrockRoleArn = !!process.env.AWS_BEDROCK_ROLE_ARN
    if (!hasAwsBedrockRoleArn || !hasAwsCredentials) {
      return { error: new Error('AWS Bedrock credentials not available') }
    }
    const bedrock = createRoutedBedrock(params.routingKey)
    const model = await bedrock(chosenModelId as BedrockModel)
    const systemProviderOptions = (
      providerRegistry.models as Record<BedrockModel, ProviderModelConfig>
    )[chosenModelId as BedrockModel]?.systemProviderOptions
    return { modelParams: { model }, systemProviderOptions }
  }

  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      return { error: new Error('OPENAI_API_KEY not available') }
    }

    // Self-hosting hooks (all optional — unset ⇒ identical to the built-in
    // OpenAI behavior). Let operators point the OpenAI-compatible client at a
    // private endpoint and/or force a specific model id via env, so non-OpenAI
    // LLMs (Azure OpenAI, LiteLLM, vLLM, Ollama, …) work without code changes:
    //   OPENAI_BASE_URL         custom OpenAI-compatible endpoint, e.g. https://gateway/v1
    //   OPENAI_ASSISTANT_MODEL  model id to send, e.g. gpt-4o / qwen2.5-coder
    const customBaseURL = process.env.OPENAI_BASE_URL
    const customModelId = process.env.OPENAI_ASSISTANT_MODEL
    const isCustomEndpoint = !!customBaseURL || !!customModelId

    const openaiProvider = customBaseURL
      ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: customBaseURL })
      : openai
    const resolvedModelId = customModelId ?? (chosenModelId as OpenAIModelId)

    // reasoningEffort + `store` are OpenAI-reasoning-model specifics; custom
    // endpoints/models frequently reject unknown request fields, so omit them.
    const baseProviderOptions = providerRegistry.providerOptions?.openai ?? {}
    const openaiProviderOptions = isCustomEndpoint
      ? {}
      : modelEntry?.reasoningEffort
        ? { ...baseProviderOptions, reasoningEffort: modelEntry.reasoningEffort }
        : baseProviderOptions

    return {
      modelParams: {
        model: openaiProvider(resolvedModelId),
        providerOptions: { openai: openaiProviderOptions },
      },
      systemProviderOptions: isCustomEndpoint
        ? undefined
        : models[chosenModelId as OpenAIModelId]?.systemProviderOptions,
    }
  }

  return { error: new Error(`Unsupported provider: ${provider}`) }
}

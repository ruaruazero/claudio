import { z } from "zod";
import { ChatDeepSeek } from "@langchain/deepseek";
import { HumanMessage } from "@langchain/core/messages";
import { MusicCredentials, type CredentialCodec } from "./music-account.js";
import { MimoSpeech } from "./speech.js";
import { createModelFetch } from "./model-network.js";
import { classifyFailure } from "./incidents.js";
import { Fault } from "./store.js";

const modelName = z.string().trim().min(1).max(100).regex(/^[\w.:-]+$/);
const secret = z.string().trim().min(1).max(512).regex(/^[!-~]+$/);
export const ServiceUpdate = z.object({
  service: z.enum(["model", "speech"]), model: modelName,
  apiKey: secret.optional(), clearKey: z.boolean().optional(),
}).strict().refine(value => !(value.clearKey && value.apiKey));
type Config = { modelKey?: string; model: string; speechKey?: string; speechModel: string };
export class ServiceConfiguration {
  private credentials: MusicCredentials;
  private config: Config;
  constructor(directory: string, private defaults: Config & { baseURL: string; voice: string }, codec?: CredentialCodec) {
    this.credentials = new MusicCredentials(directory, "ai-services", codec);
    const saved = this.credentials.read();
    const schema = z.object({ modelKey: secret.optional(), model: modelName,
      speechKey: secret.optional(), speechModel: modelName });
    this.config = saved ? schema.parse(JSON.parse(saved)) : { modelKey: defaults.modelKey,
      model: defaults.model, speechKey: defaults.speechKey, speechModel: defaults.speechModel };
  }
  status() {
    return { model: { provider: "DeepSeek", model: this.config.model, configured: Boolean(this.config.modelKey) },
      speech: { provider: "小米 MiMo", model: this.config.speechModel, configured: Boolean(this.config.speechKey) } };
  }
  runtime(config = this.config) {
    const create = (maxTokens: number) => config.modelKey ? new ChatDeepSeek({
      apiKey: config.modelKey, model: config.model,
      configuration: { baseURL: this.defaults.baseURL, fetch: createModelFetch() },
      maxRetries: 0, maxTokens, timeout: 25_000, modelKwargs: { thinking: { type: "disabled" } },
    }) : null;
    return { model: create(600), auxiliaryModel: create(1600), modelName: config.modelKey ? config.model : null,
      speech: config.speechKey ? new MimoSpeech(config.speechKey, config.speechModel, this.defaults.voice) : null };
  }
  prepare(input: z.infer<typeof ServiceUpdate>) {
    const next = { ...this.config };
    if (input.service === "model") {
      next.model = input.model;
      if (input.clearKey) delete next.modelKey;
      else if (input.apiKey) next.modelKey = input.apiKey;
    } else {
      next.speechModel = input.model;
      if (input.clearKey) delete next.speechKey;
      else if (input.apiKey) next.speechKey = input.apiKey;
    }
    return { runtime: this.runtime(next), commit: () => {
      this.credentials.save(JSON.stringify(next)); this.config = next;
    } };
  }
  async verify(service: "model" | "speech") {
    const runtime = this.runtime();
    try {
      if (service === "model") {
        if (!runtime.model) throw new Fault("MODEL_CONFIGURATION", 400);
        await runtime.model.invoke([new HumanMessage("Reply OK.")], { signal: AbortSignal.timeout(15_000) });
      } else {
        if (!runtime.speech) throw new Fault("TTS_NOT_CONFIGURED", 400);
        await runtime.speech.synthesize("你好。", AbortSignal.timeout(15_000));
      }
      return { verified: true as const };
    } catch (error) {
      const code = service === "model" ? classifyFailure(error) : error instanceof Fault ? error.code : "TTS_PROVIDER_FAILED";
      throw new Fault(code, 502);
    }
  }
}

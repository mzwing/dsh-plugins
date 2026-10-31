export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type ThinkingLevel = (typeof thinkingLevels)[number]

export type Modality = 'text' | 'image'

/** pi-ai's spelling: a missing level keeps its default, `null` withholds it. */
export type ThinkingLevelMap = { [K in ThinkingLevel]?: string | null | undefined }

/** llm-pi-ai's spelling: only the listed levels are offered, and only `off` may go without a wire value. */
export type ReasoningEfforts = { [K in ThinkingLevel]?: string | null | undefined }

/** The llm-pi-ai model entry fields this plugin writes; rules and model gates override in the same terms. */
export interface ModelFields {
  name?: string | undefined
  contextWindow?: number | undefined
  maxTokens?: number | undefined
  input?: Modality[] | undefined
  reasoningEfforts?: false | ReasoningEfforts | undefined
}

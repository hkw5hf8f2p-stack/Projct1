export interface PromptDef {
  id: string;
  system: string;
  /** статичний шаблон із {{ПЛЕЙСХОЛДЕРАМИ}}; саме він хешується в lock, а не підставлені дані */
  user_template: string;
  /** додаткові тексти, які код підставляє в запит (напр. повторний запит про полюси); входять у хеш */
  fragments?: Record<string, string>;
  output_name: string;
  output_description: string;
  json_schema: Record<string, unknown>;
}

# Conversation-first Thesis panel

23 October 2026. User requested the agent experience follow https://getagent.studio/.

Reference evidence: public HTML and linked AndrewWidget JavaScript/CSS inspected over HTTP. Public interface strings confirm a named assistant, introduction, starting prompts, message composer, memory and expand controls. Full browser rendering could not be inspected because Work settings disable local browser use; no pixel-match claim is made. No proprietary implementation or assets were copied.

Implemented: compact assistant header, contextual event card and Details link; centered introduction with clickable prompts; single main composer pinned below the conversation area; memory link and expand/restore control. Review pick opens the existing protected form only on demand, retaining account checks, source identity and retry receipts. Draft stays separated by market/platform/provider. Removed technical context labels and repeated configuration messages from the main panel. Agent unavailable notice stays explicit and Send disabled; no fabricated response or live memory claim. The welcome prompt is static interface copy, not generated model output.

Validation: unit/type/lint/build checks recorded in execution status. Final browser visual and interaction verification remains unavailable under the current Work setting. Auth/LLM/Walrus runtime credentials remain missing. No new API or remote AI integration is claimed.

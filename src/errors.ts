export type SymphonyErrorCode =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map'
  | 'template_parse_error'
  | 'template_render_error'
  | 'unsupported_tracker_kind'
  | 'invalid_tracker_config'
  | 'queue_root_missing'
  | 'queue_item_invalid_id'
  | 'queue_item_malformed'
  | 'queue_item_not_found'
  | 'queue_path_escape'
  | 'queue_write_failed'
  | 'invalid_workspace_cwd'
  | 'agent_server_unreachable'
  | 'response_timeout'
  | 'turn_timeout'
  | 'response_error'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_input_required'

export class SymphonyError extends Error {
  constructor(
    public code: SymphonyErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SymphonyError'
  }
}

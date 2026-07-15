export interface DocParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
  defaultValue?: string;
}

export interface DocHeader {
  name: string;
  required: boolean;
  description: string;
}

export interface DocRequest {
  module: string;
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  endpoint: string;
  description: string;
  params: DocParam[];
  headers: DocHeader[];
  requestBody?: Record<string, unknown>;
  expectedStatusCodes: number[];
  docUrl: string;
}

export interface TryOutField {
  name: string;
  type: string;
  defaultValue?: string;
}

export interface TryOutData {
  requestName: string;
  params: TryOutField[];
  headers: TryOutField[];
  bodyContent?: string;
  defaultResponseCode?: number; // code shown BEFORE send is clicked
}

export interface PostmanParam {
  key: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface PostmanRequest {
  name: string;
  method: string;
  url: string;
  params: PostmanParam[];
  headers: PostmanParam[];
  body?: {
    mode: string;
    raw?: string;
    formdata?: PostmanParam[];
  };
}

export interface ComparisonResult {
  requestName: string;
  endpoint: string;
  method: string;
  docUrl: string;
  mismatches: Mismatch[];
  status: 'pass' | 'warning' | 'fail';
}

export interface Mismatch {
  type: 'missing_in_doc' | 'missing_in_tryout' | 'missing_in_postman' | 'name_mismatch' | 'required_mismatch' | 'body_mismatch' | 'extra_in_tryout' | 'default_error_response' | 'request_body_mismatch' | 'response_body_mismatch' | 'newman_failure' | 'known_collection_issue';
  field?: string;
  source: string;
  detail: string;
  severity: 'error' | 'warning' | 'info'; // 'info' does not affect pass/warning/fail status
}

export interface TryOutTestResult {
  requestName: string;
  endpoint: string;
  method: string;
  docUrl: string;
  defaultResponseCode?: number;   // code visible before clicking Send
  actualResponseCode?: number;    // code after clicking Send
  responseBodyRaw?: string;       // raw response body text from the Try Out panel
  responseBodyKeys?: string[];    // top-level keys of the JSON response body
  passed: boolean;
  flags: string[];
}

export interface NewmanResult {
  requestName: string;
  method: string;
  url: string;
  requestBodyRaw?: string;        // raw request body sent
  requestBodyKeys?: string[];     // top-level keys of the JSON request body
  responseCode: number;
  responseBodyRaw?: string;       // raw response body received
  responseBodyKeys?: string[];    // top-level keys of the JSON response body
  passed: boolean;
  error?: string;
}

export interface ApiTestResult {
  requestName: string;
  endpoint: string;
  method: string;
  statusCode: number;
  expectedStatusCode: number;
  passed: boolean;
  responseFieldsMissing: string[];
  responseFieldsExtra: string[];
  errorMessage?: string;
  durationMs: number;
}

export interface RunReport {
  runAt: string;
  totalRequests: number;
  passed: number;
  warnings: number;
  failed: number;
  tryOutResults: TryOutTestResult[];
  comparisonResults: ComparisonResult[];
  apiTestResults: ApiTestResult[];
  newmanResults: NewmanResult[];
}

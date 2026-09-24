{{/*
Expand the name of the chart.
*/}}
{{- define "contextator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name. Truncated to 63 chars per Kubernetes name limits.
*/}}
{{- define "contextator.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "contextator.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "contextator.labels" -}}
helm.sh/chart: {{ include "contextator.chart" . }}
{{ include "contextator.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "contextator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "contextator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "contextator.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "contextator.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the Secret holding DATABASE_URL. Either the user's existingSecret, or the one this
chart creates.
*/}}
{{- define "contextator.databaseSecretName" -}}
{{- if .Values.database.existingSecret }}
{{- .Values.database.existingSecret }}
{{- else }}
{{- printf "%s-database" (include "contextator.fullname" .) }}
{{- end }}
{{- end }}

{{- define "contextator.databaseSecretKey" -}}
{{- if .Values.database.existingSecret }}
{{- .Values.database.existingSecretKey | default "DATABASE_URL" }}
{{- else }}
{{- "DATABASE_URL" }}
{{- end }}
{{- end }}

{{/*
Name of the Secret holding SECRET_KEY. Either the user's existingSecret, or the one this chart
creates (with a stable, lookup-preserved auto-generated value — see templates/secret.yaml).
*/}}
{{- define "contextator.secretKeySecretName" -}}
{{- if .Values.secretKey.existingSecret }}
{{- .Values.secretKey.existingSecret }}
{{- else }}
{{- printf "%s-secret-key" (include "contextator.fullname" .) }}
{{- end }}
{{- end }}

{{- define "contextator.secretKeySecretKey" -}}
{{- if .Values.secretKey.existingSecret }}
{{- .Values.secretKey.existingSecretKey | default "SECRET_KEY" }}
{{- else }}
{{- "SECRET_KEY" }}
{{- end }}
{{- end }}

{{/*
Hard install-time guard: refuse without a way to reach a database (ADR-0069 — the slim image
carries no PostgreSQL of its own). Mirrors docker-compose.slim.yml's
`DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL...}` pattern in Helm terms.
*/}}
{{- define "contextator.requireDatabase" -}}
{{- if and (not .Values.database.url) (not .Values.database.existingSecret) -}}
{{- fail "contextator: set database.url (a postgres:// connection string to an external, pgvector-enabled PostgreSQL) or database.existingSecret — the slim image this chart deploys carries no database of its own (ADR-0069). See charts/contextator/README.md." -}}
{{- end -}}
{{- end -}}

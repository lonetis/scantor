<script setup lang="ts">
// The facts of a revision (docs/ui.md §5.9): source, git provenance, base image, image, platform, connector,
// protocol and schedule.
const props = defineProps<{ revision: Revision }>()

interface Fact {
  label: string
  value: string
  mono?: boolean
  copy?: boolean
}

const facts = computed<Fact[]>(() => {
  const revision = props.revision
  const rows: Fact[] = [
    { label: 'Source', value: revision.source.kind },
    { label: 'Pack hash', value: revision.source.packSha256, mono: true, copy: true },
    { label: 'Files', value: formatCount(revision.source.fileCount) },
    { label: 'Packed size', value: formatBytes(revision.source.packBytes) },
  ]
  const git = revision.source.git
  if (git) {
    rows.push(
      { label: 'Git', value: `${git.url}@${git.ref}:${git.path}`, mono: true },
      { label: 'Commit', value: git.commit, mono: true, copy: true },
      { label: 'Git state', value: git.dirty ? 'changed since the last import or pull' : 'as imported or pulled' },
    )
  }
  if (revision.baseImage) {
    rows.push({ label: 'Base image', value: revision.baseImage.ref, mono: true }, { label: 'Base digest', value: revision.baseImage.digest, mono: true, copy: true })
  }
  if (revision.image) {
    rows.push(
      { label: 'Image', value: revision.image.repository, mono: true },
      { label: 'Digest', value: revision.image.digest, mono: true, copy: true },
      { label: 'Image size', value: formatBytes(revision.image.bytes) },
      { label: 'Platform', value: `${revision.image.platform.os}/${revision.image.platform.arch}`, mono: true },
    )
  }
  const description = revision.description
  if (description) {
    rows.push(
      { label: 'Connector', value: `${description.connector.language} ${description.connector.version}` },
      { label: 'Protocol', value: String(description.protocolVersion) },
      { label: 'Schedule', value: description.schedule.kind === 'template' ? `template:${description.schedule.template}` : 'custom', mono: true },
    )
  }
  return rows
})
</script>

<template>
  <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
    <template v-for="fact in facts" :key="fact.label">
      <dt class="text-xs text-muted">{{ fact.label }}</dt>
      <dd class="flex min-w-0 items-center gap-1" :class="fact.mono ? 'font-mono text-xs' : ''">
        <span class="truncate" :title="fact.value">{{ fact.value }}</span>
        <CopyButton v-if="fact.copy" :value="fact.value" :label="`Copy ${fact.label.toLowerCase()}`" size="xs" />
      </dd>
    </template>
  </dl>
</template>

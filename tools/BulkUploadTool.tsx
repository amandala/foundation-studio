import React, {useCallback, useEffect, useRef, useState} from 'react'
import {useClient} from 'sanity'
import {Badge, Box, Button, Card, Flex, Spinner, Stack, Text, TextInput} from '@sanity/ui'
import {AddIcon, UploadIcon} from '@sanity/icons'

type Tag = {
  _id: string
  name: string
  slug: string
}

type FileEntry = {
  id: string
  file: File
  preview: string
  caption: string
  photoCredit: string
  tagIds: string[]
  status: 'pending' | 'uploading' | 'done' | 'error'
  error?: string
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

const tagPillStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
  padding: '2px 10px',
  borderRadius: 9999,
  border: '1px solid',
  borderColor: active ? '#2563eb' : 'var(--card-border-color)',
  background: active ? '#2563eb' : 'transparent',
  color: active ? '#fff' : 'inherit',
  fontSize: 11,
  cursor: disabled ? 'default' : 'pointer',
  transition: 'all 0.15s ease',
})

export function BulkUploadTool() {
  const client = useClient({apiVersion: '2024-01-01'})
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [tags, setTags] = useState<Tag[]>([])
  const [files, setFiles] = useState<FileEntry[]>([])
  const [uploading, setUploading] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  // Per-file new tag input state
  const [newTagInputs, setNewTagInputs] = useState<Record<string, string>>({})
  const [creatingTag, setCreatingTag] = useState<Record<string, boolean>>({})

  useEffect(() => {
    client
      .fetch<Tag[]>('*[_type == "tag"]{_id, name, "slug": slug.current} | order(name asc)')
      .then(setTags)
  }, [client])

  useEffect(() => {
    return () => files.forEach((f) => URL.revokeObjectURL(f.preview))
  }, [files])

  const addFiles = useCallback((incoming: File[]) => {
    const imageFiles = incoming.filter((f) => f.type.startsWith('image/'))
    setFiles((prev) => [
      ...prev,
      ...imageFiles.map((file) => ({
        id: `${file.name}-${Date.now()}-${Math.random()}`,
        file,
        preview: URL.createObjectURL(file),
        caption: '',
        photoCredit: '',
        tagIds: [],
        status: 'pending' as const,
      })),
    ])
  }, [])

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files))
    e.target.value = ''
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    addFiles(Array.from(e.dataTransfer.files))
  }

  const removeFile = (id: string) => {
    setFiles((prev) => {
      const entry = prev.find((f) => f.id === id)
      if (entry) URL.revokeObjectURL(entry.preview)
      return prev.filter((f) => f.id !== id)
    })
  }

  const updateFile = (id: string, field: 'caption' | 'photoCredit', value: string) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? {...f, [field]: value} : f)))
  }

  const toggleTag = (fileId: string, tagId: string) => {
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== fileId) return f
        const tagIds = f.tagIds.includes(tagId)
          ? f.tagIds.filter((t) => t !== tagId)
          : [...f.tagIds, tagId]
        return {...f, tagIds}
      }),
    )
  }

  const createTag = async (fileId: string) => {
    const name = (newTagInputs[fileId] || '').trim()
    if (!name) return

    const slug = slugify(name)
    setCreatingTag((prev) => ({...prev, [fileId]: true}))

    try {
      // Reuse existing tag if slug already exists
      const existing = tags.find((t) => t.slug === slug)
      if (existing) {
        if (!files.find((f) => f.id === fileId)?.tagIds.includes(existing._id)) {
          toggleTag(fileId, existing._id)
        }
      } else {
        const created = await client.create({
          _type: 'tag',
          name,
          slug: {_type: 'slug', current: slug},
        })
        const newTag: Tag = {_id: created._id, name, slug}
        setTags((prev) => [...prev, newTag].sort((a, b) => a.name.localeCompare(b.name)))
        toggleTag(fileId, created._id)
      }
      setNewTagInputs((prev) => ({...prev, [fileId]: ''}))
    } catch (err) {
      console.error('Failed to create tag:', err)
    } finally {
      setCreatingTag((prev) => ({...prev, [fileId]: false}))
    }
  }

  const upload = async () => {
    setUploading(true)

    for (const entry of files) {
      if (entry.status === 'done') continue

      setFiles((prev) => prev.map((f) => (f.id === entry.id ? {...f, status: 'uploading'} : f)))

      try {
        const asset = await client.assets.upload('image', entry.file, {filename: entry.file.name})

        const docId = crypto.randomUUID().replace(/-/g, '').slice(0, 22)
        const doc: Record<string, unknown> = {
          _id: docId,
          _type: 'galleryImage',
          image: {_type: 'image', asset: {_type: 'reference', _ref: asset._id}},
        }
        if (entry.caption) doc.caption = entry.caption
        if (entry.photoCredit) doc.photoCredit = entry.photoCredit
        if (entry.tagIds.length > 0) {
          doc.tags = entry.tagIds.map((tagId, i) => ({
            _type: 'reference',
            _ref: tagId,
            _key: `tag-${i}`,
          }))
        }

        await client.createIfNotExists(doc)
        setFiles((prev) => prev.map((f) => (f.id === entry.id ? {...f, status: 'done'} : f)))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed'
        setFiles((prev) =>
          prev.map((f) => (f.id === entry.id ? {...f, status: 'error', error: message} : f)),
        )
      }
    }

    setUploading(false)
  }

  const specialTagSlugs = ['oldschool', 'newschool']
  const specialTags = tags.filter((t) => specialTagSlugs.includes(t.slug))

  const applyTagToAll = (tagId: string) => {
    const pending = files.filter((f) => f.status !== 'done')
    const allHaveIt = pending.length > 0 && pending.every((f) => f.tagIds.includes(tagId))
    setFiles((prev) =>
      prev.map((f) => {
        if (f.status === 'done') return f
        const tagIds = allHaveIt
          ? f.tagIds.filter((t) => t !== tagId)
          : f.tagIds.includes(tagId)
            ? f.tagIds
            : [...f.tagIds, tagId]
        return {...f, tagIds}
      }),
    )
  }

  const pendingCount = files.filter((f) => f.status === 'pending').length
  const doneCount = files.filter((f) => f.status === 'done').length
  const errorCount = files.filter((f) => f.status === 'error').length
  const allDone = files.length > 0 && doneCount + errorCount === files.length && !uploading

  const reset = () => {
    files.forEach((f) => URL.revokeObjectURL(f.preview))
    setFiles([])
  }

  return (
    <Box padding={5} style={{maxWidth: 900, margin: '0 auto'}}>
      <Stack space={5}>
        <Stack space={4}>
          <Text size={4} weight="semibold">
            Bulk Image Upload
          </Text>
          <Text muted size={1}>
            Upload multiple images to the gallery at once. All fields except the image are optional.
          </Text>
        </Stack>

        {/* Drop zone */}
        <Card
          border
          radius={2}
          padding={6}
          tone={isDragOver ? 'primary' : 'transparent'}
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragOver(true)
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !uploading && fileInputRef.current?.click()}
          style={{cursor: uploading ? 'default' : 'pointer', textAlign: 'center'}}
        >
          <Stack space={3}>
            <Text size={5}>📷</Text>
            <Text weight="semibold">Drop images here or click to browse</Text>
            <Text size={1} muted>
              JPG, PNG, WebP, GIF — select as many as you like
            </Text>
          </Stack>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{display: 'none'}}
            onChange={handleFileInput}
          />
        </Card>

        {/* Apply-to-all shortcut for special tags */}
        {files.some((f) => f.status !== 'done') && specialTags.length > 0 && (
          <Flex align="center" gap={3}>
            <Text size={1} muted style={{flexShrink: 0}}>
              Apply to all:
            </Text>
            <Flex gap={2} wrap="wrap">
              {specialTags.map((tag) => {
                const pending = files.filter((f) => f.status !== 'done')
                const allHaveIt =
                  pending.length > 0 && pending.every((f) => f.tagIds.includes(tag._id))
                return (
                  <button
                    key={tag._id}
                    onClick={() => applyTagToAll(tag._id)}
                    disabled={uploading}
                    style={{
                      ...tagPillStyle(allHaveIt, uploading),
                      padding: '4px 14px',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {tag.name}
                  </button>
                )
              })}
            </Flex>
          </Flex>
        )}

        {/* File list */}
        {files.length > 0 && (
          <Stack space={3}>
            <Flex justify="space-between" align="center">
              <Text weight="semibold">
                {files.length} image{files.length !== 1 ? 's' : ''} selected
              </Text>
              <Flex gap={2} align="center">
                {doneCount > 0 && <Badge tone="positive">{doneCount} uploaded</Badge>}
                {errorCount > 0 && <Badge tone="critical">{errorCount} failed</Badge>}
              </Flex>
            </Flex>

            <Stack space={2}>
              {files.map((entry) => (
                <Card key={entry.id} border radius={2} padding={3}>
                  <Flex gap={3} align="flex-start">
                    {/* Thumbnail */}
                    <Box style={{flexShrink: 0}}>
                      <img
                        src={entry.preview}
                        alt={entry.file.name}
                        style={{
                          width: 56,
                          height: 56,
                          objectFit: 'cover',
                          borderRadius: 4,
                          display: 'block',
                        }}
                      />
                    </Box>

                    {/* File info + inputs */}
                    <Box style={{flex: 1, minWidth: 0}}>
                      <Stack space={2}>
                        {/* Filename + status */}
                        <Flex align="flex-start" gap={2}>
                          <Box style={{flexShrink: 0, paddingTop: 2}}>
                            {entry.status === 'uploading' && <Spinner />}
                            {entry.status === 'done' && <Text>✅</Text>}
                            {entry.status === 'error' && <Text>❌</Text>}
                          </Box>
                          <Stack space={1}>
                            <Text size={1} weight="semibold" style={{wordBreak: 'break-word'}}>
                              {entry.file.name}
                            </Text>
                            <Text size={0} muted>
                              {(entry.file.size / 1024 / 1024).toFixed(1)} MB
                            </Text>
                          </Stack>
                        </Flex>

                        {entry.status === 'error' && (
                          <Text size={0} style={{color: 'var(--card-badge-critical-bg-color)'}}>
                            {entry.error}
                          </Text>
                        )}

                        {entry.status !== 'done' && (
                          <>
                            {/* Caption + credit */}
                            <Flex gap={2}>
                              <Box style={{flex: 1}}>
                                <TextInput
                                  placeholder="Caption (optional)"
                                  value={entry.caption}
                                  onChange={(e) =>
                                    updateFile(entry.id, 'caption', e.currentTarget.value)
                                  }
                                  disabled={uploading}
                                  fontSize={1}
                                />
                              </Box>
                              <Box style={{flex: 1}}>
                                <TextInput
                                  placeholder="Photo credit (optional)"
                                  value={entry.photoCredit}
                                  onChange={(e) =>
                                    updateFile(entry.id, 'photoCredit', e.currentTarget.value)
                                  }
                                  disabled={uploading}
                                  fontSize={1}
                                />
                              </Box>
                            </Flex>

                            {/* Tag toggles + new tag input */}
                            <Flex gap={1} wrap="wrap" align="center">
                              {tags
                                .filter((t) => !specialTagSlugs.includes(t.slug))
                                .map((tag) => {
                                  const active = entry.tagIds.includes(tag._id)
                                  return (
                                    <button
                                      key={tag._id}
                                      onClick={() => !uploading && toggleTag(entry.id, tag._id)}
                                      disabled={uploading}
                                      style={tagPillStyle(active, uploading)}
                                    >
                                      {tag.name}
                                    </button>
                                  )
                                })}

                              {/* New tag inline input */}
                              <Flex gap={1} align="center" style={{marginLeft: 4}}>
                                <Box style={{width: 120}}>
                                  <TextInput
                                    placeholder="New tag…"
                                    value={newTagInputs[entry.id] || ''}
                                    onChange={(e) => {
                                      const value = e.currentTarget.value
                                      setNewTagInputs((prev) => ({...prev, [entry.id]: value}))
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') createTag(entry.id)
                                    }}
                                    disabled={uploading || creatingTag[entry.id]}
                                    fontSize={1}
                                  />
                                </Box>
                                {creatingTag[entry.id] ? (
                                  <Spinner />
                                ) : (
                                  <Button
                                    icon={AddIcon}
                                    mode="ghost"
                                    tone="primary"
                                    onClick={() => createTag(entry.id)}
                                    disabled={uploading || !newTagInputs[entry.id]?.trim()}
                                    title="Create tag"
                                  />
                                )}
                              </Flex>
                            </Flex>
                          </>
                        )}

                        {/* Show applied tags after upload */}
                        {entry.status === 'done' && entry.tagIds.length > 0 && (
                          <Flex gap={1} wrap="wrap">
                            {entry.tagIds.map((id) => {
                              const tag = tags.find((t) => t._id === id)
                              return tag ? (
                                <Badge key={id} tone="positive" fontSize={0}>
                                  {tag.name}
                                </Badge>
                              ) : null
                            })}
                          </Flex>
                        )}
                      </Stack>
                    </Box>

                    {/* Remove button */}
                    {entry.status !== 'done' && (
                      <Button
                        mode="ghost"
                        tone="critical"
                        text="✕"
                        onClick={() => removeFile(entry.id)}
                        disabled={uploading}
                        style={{flexShrink: 0}}
                      />
                    )}
                  </Flex>
                </Card>
              ))}
            </Stack>
          </Stack>
        )}

        {/* Actions */}
        <Flex gap={3}>
          {pendingCount > 0 && (
            <Button
              icon={UploadIcon}
              text={uploading ? 'Uploading…' : `Upload ${pendingCount} image${pendingCount !== 1 ? 's' : ''}`}
              tone="primary"
              onClick={upload}
              disabled={uploading}
            />
          )}
          {allDone && <Button mode="ghost" text="Upload more images" onClick={reset} />}
          {files.length > 0 && !uploading && (
            <Button mode="ghost" tone="critical" text="Clear all" onClick={reset} />
          )}
        </Flex>
      </Stack>
    </Box>
  )
}

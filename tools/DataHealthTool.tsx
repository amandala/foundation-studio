import React, {useCallback, useEffect, useState} from 'react'
import {useClient} from 'sanity'
import {Badge, Box, Button, Card, Flex, Spinner, Stack, Text, TextInput} from '@sanity/ui'
import {
  CheckmarkCircleIcon,
  WarningOutlineIcon,
  SyncIcon,
  TrashIcon,
  SearchIcon,
  AddIcon,
} from '@sanity/icons'

// ── Types ──────────────────────────────────────────────────────────────────────

type TagDoc = {
  _id: string
  name: string
  slug: string | null
  refCount: number
  isDraft?: boolean
}

type GalleryImageDoc = {
  _id: string
  assetRef: string | null
  caption: string | null
  photoCredit: string | null
  tagIds: string[]
  tagSlugs: string[]
  imageUrl: string | null
}

type DuplicateGroup = {
  assetRef: string
  images: GalleryImageDoc[]
}

type DraftDoc = {
  _id: string
  _type: string
  title: string | null
  imageUrl: string | null
  assetRef: string | null
  hasDuplicate: boolean
}

type EventDoc = {
  _id: string
  name: string
  imageIds: string[]
}

type BrokenRefDoc = {
  _id: string
  _type: string
  title: string | null
  brokenRefs: string[]
}

type OrphanedAsset = {
  _id: string
  url: string
  size: number
}

type IssueType =
  | 'duplicate-image'
  | 'missing-slug'
  | 'slug-mismatch'
  | 'duplicate-tag'
  | 'orphaned-tag'
  | 'untagged-image'
  | 'missing-credit'
  | 'broken-refs'
  | 'unpublished-draft'
  | 'event-gallery'

type Issue = {
  type: IssueType
  severity: 'error' | 'warning' | 'info'
  label: string
  count: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const slugify = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

// ── Queries ────────────────────────────────────────────────────────────────────

const TAGS_QUERY = `*[_type == "tag" && !(_id in path("drafts.**"))]{
  _id,
  name,
  "slug": slug.current,
  "refCount": count(*[_type == "galleryImage" && !(_id in path("drafts.**")) && references(^._id)])
} | order(name asc)`

// Also fetch draft tags for dedup detection
const DRAFT_TAGS_QUERY = `*[_type == "tag" && _id in path("drafts.**")]{
  _id,
  name,
  "slug": slug.current,
  "refCount": 0
} | order(name asc)`

const GALLERY_IMAGES_QUERY = `*[_type == "galleryImage" && !(_id in path("drafts.**"))]{
  _id,
  "assetRef": image.asset._ref,
  caption,
  photoCredit,
  "tagIds": tags[]._ref,
  "tagSlugs": tags[]->slug.current,
  "imageUrl": image.asset->url
} | order(_createdAt desc)`

const UNPUBLISHED_DRAFTS_QUERY = `*[_id in path("drafts.**")]{
  _id,
  _type,
  "publishedId": string::split(_id, "drafts.")[1],
  "title": coalesce(name, title, caption, "Untitled"),
  "imageUrl": coalesce(image.asset->url, coverImage.asset->url, mainImage.asset->url),
  "assetRef": image.asset._ref
}[!defined(*[_id == ^.publishedId][0]._id)]`

const EVENTS_QUERY = `*[_type == "event" && !(_id in path("drafts.**"))]{
  _id,
  name,
  "imageIds": featuredGalleryImages[]._ref
} | order(startDate desc)`

// Documents with references that point to non-existent documents
const BROKEN_REFS_QUERY = `*[!(_id in path("drafts.**")) && (
  _type == "galleryImage" ||
  _type == "event" ||
  _type == "post" ||
  _type == "homePage"
)]{
  _id,
  _type,
  "title": coalesce(name, title, caption, "Untitled"),
  "allRefs": [
    ...tags[]._ref,
    ...featuredGalleryImages[]._ref,
    ...eventPartners[]._ref,
    ...featuredPosts[]._ref,
    ...select(_type == "post" => [event._ref], [])
  ]
}[count(allRefs) > 0]`

// Image assets not referenced by any document
const ORPHANED_ASSETS_QUERY = `*[_type == "sanity.imageAsset" && !defined(*[
  (_type == "galleryImage" && image.asset._ref == ^._id) ||
  (_type == "event" && coverImage.asset._ref == ^._id) ||
  (_type == "post" && mainImage.asset._ref == ^._id) ||
  (_type == "partner" && image.asset._ref == ^._id) ||
  (_type == "homePage" && (heroMedia.image.asset._ref == ^._id || heroMedia.videoFile.asset._ref == ^._id))
][0])]{
  _id,
  url,
  size
} | order(_createdAt desc) [0...200]`

// ── Component ──────────────────────────────────────────────────────────────────

export function DataHealthTool() {
  const client = useClient({apiVersion: '2024-01-01'})

  const [loading, setLoading] = useState(true)
  const [tags, setTags] = useState<TagDoc[]>([])
  const [draftTags, setDraftTags] = useState<TagDoc[]>([])
  const [images, setImages] = useState<GalleryImageDoc[]>([])
  const [drafts, setDrafts] = useState<DraftDoc[]>([])
  const [events, setEvents] = useState<EventDoc[]>([])
  const [brokenRefDocs, setBrokenRefDocs] = useState<BrokenRefDoc[]>([])
  const [orphanedAssets, setOrphanedAssets] = useState<OrphanedAsset[]>([])
  const [activeTab, setActiveTab] = useState<IssueType | null>(null)
  const [fixing, setFixing] = useState<string | null>(null)
  const [mergedAssets, setMergedAssets] = useState<Set<string>>(new Set())
  const [mergeProgress, setMergeProgress] = useState<{current: number; total: number} | null>(null)

  // Event gallery helper state
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [eventSearchQuery, setEventSearchQuery] = useState('')
  const [imageSearchQuery, setImageSearchQuery] = useState('')
  const [visibleImageCount, setVisibleImageCount] = useState(80)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [
        fetchedTags,
        fetchedDraftTags,
        fetchedImages,
        fetchedDrafts,
        fetchedEvents,
        fetchedRefDocs,
        fetchedOrphanedAssets,
      ] = await Promise.all([
        client.fetch<TagDoc[]>(TAGS_QUERY),
        client.fetch<TagDoc[]>(DRAFT_TAGS_QUERY),
        client.fetch<GalleryImageDoc[]>(GALLERY_IMAGES_QUERY),
        client.fetch<DraftDoc[]>(UNPUBLISHED_DRAFTS_QUERY),
        client.fetch<EventDoc[]>(EVENTS_QUERY),
        client.fetch<{_id: string; _type: string; title: string | null; allRefs: string[]}[]>(
          BROKEN_REFS_QUERY,
        ),
        client.fetch<OrphanedAsset[]>(ORPHANED_ASSETS_QUERY),
      ])
      setTags(fetchedTags)
      setDraftTags(fetchedDraftTags)
      setImages(fetchedImages)
      setEvents(fetchedEvents)
      setOrphanedAssets(fetchedOrphanedAssets)

      // Check if drafts have published duplicates (same asset)
      const publishedAssets = new Set(fetchedImages.map((img) => img.assetRef).filter(Boolean))
      setDrafts(
        fetchedDrafts.map((d) => ({
          ...d,
          hasDuplicate: d.assetRef ? publishedAssets.has(d.assetRef) : false,
        })),
      )

      // Compute broken references — check which refs point to non-existent docs
      const allDocIds = new Set([
        ...fetchedTags.map((t) => t._id),
        ...fetchedDraftTags.map((t) => t._id),
        ...fetchedImages.map((i) => i._id),
        ...fetchedEvents.map((e) => e._id),
      ])
      // Also fetch partner and post IDs for reference checking
      const otherIds = await client.fetch<string[]>(
        `*[_type in ["partner", "post"] && !(_id in path("drafts.**"))]._id`,
      )
      for (const id of otherIds) allDocIds.add(id)

      const broken: BrokenRefDoc[] = []
      for (const doc of fetchedRefDocs) {
        const refs = (doc.allRefs || []).filter(Boolean)
        const brokenRefs = refs.filter((ref) => !allDocIds.has(ref))
        if (brokenRefs.length > 0) {
          broken.push({_id: doc._id, _type: doc._type, title: doc.title, brokenRefs})
        }
      }
      setBrokenRefDocs(broken)
    } catch (err) {
      console.error('Failed to fetch data:', err)
    }
    setLoading(false)
  }, [client])

  useEffect(() => {
    refresh()
  }, [refresh])

  // ── Computed issues ────────────────────────────────────────────────────────

  const missingSlugTags = tags.filter((t) => !t.slug)

  // Slug/name mismatch
  const slugMismatchTags = tags.filter((t) => {
    if (!t.slug || !t.name) return false
    const expected = slugify(t.name)
    return t.slug !== expected
  })

  // Duplicate tags — include draft tags in detection
  const allTagsForDedup = [
    ...tags,
    ...draftTags.map((t) => ({...t, isDraft: true})),
  ]
  const duplicateTagGroups: Map<string, TagDoc[]> = new Map()
  for (const tag of allTagsForDedup) {
    if (!tag.slug) continue
    const key = tag.slug.toLowerCase()
    if (!duplicateTagGroups.has(key)) duplicateTagGroups.set(key, [])
    duplicateTagGroups.get(key)!.push(tag)
  }
  const duplicateTags = Array.from(duplicateTagGroups.entries()).filter(
    ([, group]) => group.length > 1,
  )

  const orphanedTags = tags.filter((t) => t.refCount === 0)

  const duplicateImageGroups: DuplicateGroup[] = []
  const assetMap = new Map<string, GalleryImageDoc[]>()
  for (const img of images) {
    if (!img.assetRef) continue
    if (!assetMap.has(img.assetRef)) assetMap.set(img.assetRef, [])
    assetMap.get(img.assetRef)!.push(img)
  }
  for (const [assetRef, group] of assetMap) {
    if (group.length > 1) duplicateImageGroups.push({assetRef, images: group})
  }

  // Untagged images
  const specialSlugs = ['oldschool', 'newschool']
  const untaggedImages = images.filter((img) => {
    const slugs = (img.tagSlugs || []).filter(Boolean)
    const hasSpecial = slugs.some((s) => specialSlugs.includes(s))
    const hasArtist = slugs.some((s) => !specialSlugs.includes(s))
    return !hasSpecial || !hasArtist
  })

  // Missing photo credit
  const missingCreditImages = images.filter((img) => !img.photoCredit)

  // Combined broken refs + orphaned assets count
  const brokenRefsTotal = brokenRefDocs.length + orphanedAssets.length

  const issues: Issue[] = [
    {
      type: 'duplicate-image',
      severity: 'error',
      label: 'Duplicate images',
      count: duplicateImageGroups.length,
    },
    {
      type: 'broken-refs',
      severity: 'error',
      label: 'Broken refs / orphans',
      count: brokenRefsTotal,
    },
    {
      type: 'missing-slug',
      severity: 'error',
      label: 'Missing slugs',
      count: missingSlugTags.length,
    },
    {
      type: 'slug-mismatch',
      severity: 'warning',
      label: 'Slug mismatches',
      count: slugMismatchTags.length,
    },
    {
      type: 'duplicate-tag',
      severity: 'warning',
      label: 'Duplicate tags',
      count: duplicateTags.length,
    },
    {
      type: 'orphaned-tag',
      severity: 'warning',
      label: 'Unused tags',
      count: orphanedTags.length,
    },
    {
      type: 'untagged-image',
      severity: 'warning',
      label: 'Untagged images',
      count: untaggedImages.length,
    },
    {
      type: 'missing-credit',
      severity: 'warning',
      label: 'Missing credit',
      count: missingCreditImages.length,
    },
    {
      type: 'unpublished-draft',
      severity: 'warning',
      label: 'Unpublished drafts',
      count: drafts.length,
    },
    {
      type: 'event-gallery',
      severity: 'info',
      label: 'Event gallery',
      count: events.length,
    },
  ]

  const totalIssues = issues.reduce(
    (sum, i) => sum + (i.type === 'event-gallery' ? 0 : i.count),
    0,
  )

  // ── Fix actions ────────────────────────────────────────────────────────────

  const fixMissingSlug = async (tag: TagDoc) => {
    if (!tag.name) return
    setFixing(tag._id)
    const slug = slugify(tag.name)
    try {
      await client.patch(tag._id).set({slug: {_type: 'slug', current: slug}}).commit()
      await refresh()
    } catch (err) {
      console.error('Failed to fix slug:', err)
    }
    setFixing(null)
  }

  const fixAllMissingSlugs = async () => {
    setFixing('all-slugs')
    const transaction = client.transaction()
    for (const tag of missingSlugTags) {
      if (!tag.name) continue
      transaction.patch(tag._id, (p) =>
        p.set({slug: {_type: 'slug', current: slugify(tag.name)}}),
      )
    }
    try {
      await transaction.commit()
      await refresh()
    } catch (err) {
      console.error('Failed to fix all slugs:', err)
    }
    setFixing(null)
  }

  const fixSlugMismatch = async (tag: TagDoc) => {
    if (!tag.name) return
    setFixing(tag._id)
    try {
      await client
        .patch(tag._id)
        .set({slug: {_type: 'slug', current: slugify(tag.name)}})
        .commit()
      await refresh()
    } catch (err) {
      console.error('Failed to fix slug mismatch:', err)
    }
    setFixing(null)
  }

  const fixAllSlugMismatches = async () => {
    setFixing('all-slug-mismatches')
    const transaction = client.transaction()
    for (const tag of slugMismatchTags) {
      if (!tag.name) continue
      transaction.patch(tag._id, (p) =>
        p.set({slug: {_type: 'slug', current: slugify(tag.name)}}),
      )
    }
    try {
      await transaction.commit()
      await refresh()
    } catch (err) {
      console.error('Failed to fix slug mismatches:', err)
    }
    setFixing(null)
  }

  const mergeDuplicateTags = async (group: TagDoc[]) => {
    // Prefer published tags as keeper
    const published = group.filter((t) => !t.isDraft && !t._id.startsWith('drafts.'))
    const keeper = published.length > 0
      ? published.reduce((a, b) => (a.refCount >= b.refCount ? a : b))
      : group[0]
    const duplicates = group.filter((t) => t._id !== keeper._id)
    const dupeIds = duplicates.map((t) => t._id)

    setFixing(keeper._id)
    try {
      const affectedImages = await client.fetch<
        {_id: string; tagRefs: {_key: string; _ref: string}[]}[]
      >(
        `*[_type == "galleryImage" && references($dupeIds)]{_id, "tagRefs": tags[]}`,
        {dupeIds},
      )

      const transaction = client.transaction()

      for (const img of affectedImages) {
        const existingRefs = img.tagRefs || []
        const hasKeeper = existingRefs.some((r) => r._ref === keeper._id)
        const cleaned = existingRefs.filter((r) => !dupeIds.includes(r._ref))
        if (!hasKeeper) {
          cleaned.push({_key: `tag-${Date.now()}`, _ref: keeper._id})
        }
        transaction.patch(img._id, (p) =>
          p.set({
            tags: cleaned.map((r) => ({_type: 'reference', _ref: r._ref, _key: r._key})),
          }),
        )
      }

      for (const dupe of duplicates) {
        transaction.delete(dupe._id)
      }

      await transaction.commit()
      await refresh()
    } catch (err) {
      console.error('Failed to merge tags:', err)
    }
    setFixing(null)
  }

  const deleteOrphanedTag = async (tag: TagDoc) => {
    setFixing(tag._id)
    try {
      await client.delete(tag._id)
      await refresh()
    } catch (err) {
      console.error('Failed to delete tag:', err)
    }
    setFixing(null)
  }

  const deleteAllOrphanedTags = async () => {
    setFixing('all-orphans')
    const transaction = client.transaction()
    for (const tag of orphanedTags) {
      transaction.delete(tag._id)
    }
    try {
      await transaction.commit()
      await refresh()
    } catch (err) {
      console.error('Failed to delete orphaned tags:', err)
    }
    setFixing(null)
  }

  const mergeDuplicateImages = async (group: DuplicateGroup, {batch = false} = {}) => {
    const scored = group.images.map((img) => ({
      img,
      score:
        (img.caption ? 1 : 0) + (img.photoCredit ? 1 : 0) + (img.tagIds?.length || 0),
    }))
    scored.sort((a, b) => b.score - a.score)
    const keeper = scored[0].img
    const duplicates = scored.slice(1).map((s) => s.img)

    if (!batch) setFixing(keeper._id)
    try {
      const allTagIds = new Set(keeper.tagIds || [])
      for (const dupe of duplicates) {
        for (const tagId of dupe.tagIds || []) {
          allTagIds.add(tagId)
        }
      }

      const mergedCaption = keeper.caption || duplicates.find((d) => d.caption)?.caption || null
      const mergedCredit =
        keeper.photoCredit || duplicates.find((d) => d.photoCredit)?.photoCredit || null

      const transaction = client.transaction()

      const patch: Record<string, unknown> = {}
      if (allTagIds.size > 0) {
        patch.tags = Array.from(allTagIds).map((ref, i) => ({
          _type: 'reference',
          _ref: ref,
          _key: `tag-${i}`,
        }))
      }
      if (mergedCaption) patch.caption = mergedCaption
      if (mergedCredit) patch.photoCredit = mergedCredit
      transaction.patch(keeper._id, (p) => p.set(patch))

      const dupeIds = duplicates.map((d) => d._id)
      const referencingDocs = await client.fetch<{_id: string; _type: string}[]>(
        `*[references($dupeIds)]{_id, _type}`,
        {dupeIds},
      )

      for (const doc of referencingDocs) {
        const fullDoc = await client.fetch(`*[_id == $id][0]`, {id: doc._id})
        if (!fullDoc) continue

        const arrayFields = ['featuredGalleryImages', 'tags']
        for (const field of arrayFields) {
          if (!Array.isArray(fullDoc[field])) continue
          const hasKeeper = fullDoc[field].some(
            (item: {_ref?: string}) => item._ref === keeper._id,
          )
          const cleaned = fullDoc[field].filter(
            (item: {_ref?: string}) => !dupeIds.includes(item._ref || ''),
          )
          if (!hasKeeper) {
            cleaned.push({_type: 'reference', _ref: keeper._id, _key: `ref-${Date.now()}`})
          }
          transaction.patch(doc._id, (p) => p.set({[field]: cleaned}))
        }
      }

      for (const dupe of duplicates) {
        transaction.delete(dupe._id)
      }

      await transaction.commit()
      if (!batch) await refresh()
    } catch (err) {
      console.error('Failed to merge images:', err)
    }
    if (!batch) setFixing(null)
  }

  const mergeAllDuplicateImages = async () => {
    setFixing('all-dupes')
    setMergedAssets(new Set())
    const total = duplicateImageGroups.length
    setMergeProgress({current: 0, total})
    try {
      for (let i = 0; i < duplicateImageGroups.length; i++) {
        const group = duplicateImageGroups[i]
        setMergeProgress({current: i + 1, total})
        await mergeDuplicateImages(group, {batch: true})
        setMergedAssets((prev) => new Set([...prev, group.assetRef]))
      }
      await refresh()
    } catch (err) {
      console.error('Failed to merge all duplicates:', err)
    }
    setFixing(null)
    setMergeProgress(null)
    setMergedAssets(new Set())
  }

  const publishDraft = async (draft: DraftDoc) => {
    const publishedId = draft._id.replace('drafts.', '')
    setFixing(draft._id)
    try {
      const doc = await client.fetch(`*[_id == $id][0]`, {id: draft._id})
      if (!doc) return
      const {_id, _rev, _updatedAt, _createdAt, ...fields} = doc
      await client.createOrReplace({...fields, _id: publishedId})
      await client.delete(draft._id)
      await refresh()
    } catch (err) {
      console.error('Failed to publish draft:', err)
    }
    setFixing(null)
  }

  const publishAllDrafts = async () => {
    // Only publish non-duplicate drafts
    const toPublish = drafts.filter((d) => !d.hasDuplicate)
    setFixing('all-drafts')
    setMergeProgress({current: 0, total: toPublish.length})
    try {
      for (let i = 0; i < toPublish.length; i++) {
        setMergeProgress({current: i + 1, total: toPublish.length})
        const draft = toPublish[i]
        const publishedId = draft._id.replace('drafts.', '')
        const doc = await client.fetch(`*[_id == $id][0]`, {id: draft._id})
        if (!doc) continue
        const {_id, _rev, _updatedAt, _createdAt, ...fields} = doc
        await client.createOrReplace({...fields, _id: publishedId})
        await client.delete(draft._id)
      }
      await refresh()
    } catch (err) {
      console.error('Failed to publish all drafts:', err)
    }
    setFixing(null)
    setMergeProgress(null)
  }

  const deleteDraft = async (draft: DraftDoc) => {
    setFixing(draft._id)
    try {
      await client.delete(draft._id)
      await refresh()
    } catch (err) {
      console.error('Failed to delete draft:', err)
    }
    setFixing(null)
  }

  // Broken ref actions
  const removeBrokenRefs = async (doc: BrokenRefDoc) => {
    setFixing(doc._id)
    try {
      const fullDoc = await client.fetch(`*[_id == $id][0]`, {id: doc._id})
      if (!fullDoc) return
      const transaction = client.transaction()
      const arrayFields = ['tags', 'featuredGalleryImages', 'eventPartners', 'featuredPosts']
      for (const field of arrayFields) {
        if (!Array.isArray(fullDoc[field])) continue
        const cleaned = fullDoc[field].filter(
          (item: {_ref?: string}) => !doc.brokenRefs.includes(item._ref || ''),
        )
        if (cleaned.length !== fullDoc[field].length) {
          transaction.patch(doc._id, (p) => p.set({[field]: cleaned}))
        }
      }
      // Handle single reference fields (e.g. post.event)
      if (fullDoc.event?._ref && doc.brokenRefs.includes(fullDoc.event._ref)) {
        transaction.patch(doc._id, (p) => p.unset(['event']))
      }
      await transaction.commit()
      await refresh()
    } catch (err) {
      console.error('Failed to remove broken refs:', err)
    }
    setFixing(null)
  }

  const removeAllBrokenRefs = async () => {
    setFixing('all-broken')
    try {
      for (const doc of brokenRefDocs) {
        const fullDoc = await client.fetch(`*[_id == $id][0]`, {id: doc._id})
        if (!fullDoc) continue
        const transaction = client.transaction()
        const arrayFields = ['tags', 'featuredGalleryImages', 'eventPartners', 'featuredPosts']
        for (const field of arrayFields) {
          if (!Array.isArray(fullDoc[field])) continue
          const cleaned = fullDoc[field].filter(
            (item: {_ref?: string}) => !doc.brokenRefs.includes(item._ref || ''),
          )
          if (cleaned.length !== fullDoc[field].length) {
            transaction.patch(doc._id, (p) => p.set({[field]: cleaned}))
          }
        }
        if (fullDoc.event?._ref && doc.brokenRefs.includes(fullDoc.event._ref)) {
          transaction.patch(doc._id, (p) => p.unset(['event']))
        }
        await transaction.commit()
      }
      await refresh()
    } catch (err) {
      console.error('Failed to remove all broken refs:', err)
    }
    setFixing(null)
  }

  const deleteOrphanedAsset = async (asset: OrphanedAsset) => {
    setFixing(asset._id)
    try {
      await client.delete(asset._id)
      await refresh()
    } catch (err) {
      console.error('Failed to delete asset:', err)
    }
    setFixing(null)
  }

  const deleteAllOrphanedAssets = async () => {
    setFixing('all-orphan-assets')
    try {
      const transaction = client.transaction()
      for (const asset of orphanedAssets) {
        transaction.delete(asset._id)
      }
      await transaction.commit()
      await refresh()
    } catch (err) {
      console.error('Failed to delete orphaned assets:', err)
    }
    setFixing(null)
  }

  // Event gallery helpers
  const selectedEvent = events.find((e) => e._id === selectedEventId)
  const eventImageIds = new Set(selectedEvent?.imageIds || [])

  const addImageToEvent = async (imageId: string) => {
    if (!selectedEventId) return
    setFixing(imageId)
    try {
      await client
        .patch(selectedEventId)
        .setIfMissing({featuredGalleryImages: []})
        .append('featuredGalleryImages', [
          {_type: 'reference', _ref: imageId, _key: `img-${Date.now()}`},
        ])
        .commit()
      await refresh()
    } catch (err) {
      console.error('Failed to add image to event:', err)
    }
    setFixing(null)
  }

  const removeImageFromEvent = async (imageId: string) => {
    if (!selectedEventId || !selectedEvent) return
    setFixing(imageId)
    try {
      const fullEvent = await client.fetch(`*[_id == $id][0]`, {id: selectedEventId})
      if (!fullEvent?.featuredGalleryImages) return
      const filtered = fullEvent.featuredGalleryImages.filter(
        (ref: {_ref: string}) => ref._ref !== imageId,
      )
      await client.patch(selectedEventId).set({featuredGalleryImages: filtered}).commit()
      await refresh()
    } catch (err) {
      console.error('Failed to remove image from event:', err)
    }
    setFixing(null)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Box padding={5}>
        <Flex align="center" gap={3} justify="center">
          <Spinner />
          <Text>Scanning data…</Text>
        </Flex>
      </Box>
    )
  }

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 12,
  }

  return (
    <Box padding={5} style={{maxWidth: 1000, margin: '0 auto'}}>
      <Stack space={5}>
        {/* Header */}
        <Flex align="center" justify="space-between">
          <Stack space={2}>
            <Text size={4} weight="semibold">
              Data Health
            </Text>
            <Text size={1} muted>
              {tags.length} tags · {images.length} gallery images · {events.length} events
            </Text>
          </Stack>
          <Button
            icon={SyncIcon}
            text="Refresh"
            mode="ghost"
            onClick={refresh}
            disabled={!!fixing}
          />
        </Flex>

        {/* Summary cards — grid layout */}
        {totalIssues === 0 && drafts.length === 0 ? (
          <Card padding={4} radius={2} tone="positive" border>
            <Flex align="center" gap={3}>
              <Text size={3}>
                <CheckmarkCircleIcon />
              </Text>
              <Text weight="semibold">All clear — no data issues found</Text>
            </Flex>
          </Card>
        ) : (
          <div style={gridStyle}>
            {issues.map((issue) => (
              <Card
                key={issue.type}
                padding={3}
                radius={2}
                border
                tone={
                  issue.type === 'event-gallery'
                    ? 'default'
                    : issue.count > 0
                      ? issue.severity === 'error'
                        ? 'critical'
                        : 'caution'
                      : 'positive'
                }
                style={{cursor: issue.count > 0 ? 'pointer' : 'default'}}
                onClick={() =>
                  issue.count > 0 &&
                  setActiveTab(activeTab === issue.type ? null : issue.type)
                }
              >
                <Stack space={2}>
                  <Flex align="center" gap={2}>
                    {issue.type === 'event-gallery' ? (
                      <Text size={2}>
                        <SearchIcon />
                      </Text>
                    ) : issue.count > 0 ? (
                      <Text size={2}>
                        <WarningOutlineIcon />
                      </Text>
                    ) : (
                      <Text size={2}>
                        <CheckmarkCircleIcon />
                      </Text>
                    )}
                    <Text size={1} weight="semibold">
                      {issue.label}
                    </Text>
                  </Flex>
                  <Text size={3} weight="bold">
                    {issue.type === 'event-gallery' ? `${issue.count} event${issue.count !== 1 ? 's' : ''}` : issue.count}
                  </Text>
                </Stack>
              </Card>
            ))}
          </div>
        )}

        {/* ── Missing Slugs ─────────────────────────────────────────────────── */}
        {activeTab === 'missing-slug' && missingSlugTags.length > 0 && (
          <Card padding={4} radius={2} border>
            <Stack space={4}>
              <Flex align="center" justify="space-between">
                <Text weight="semibold">Tags missing slugs</Text>
                <Button
                  text={
                    fixing === 'all-slugs'
                      ? 'Fixing…'
                      : `Fix all (${missingSlugTags.length})`
                  }
                  tone="positive"
                  mode="ghost"
                  onClick={fixAllMissingSlugs}
                  disabled={!!fixing}
                />
              </Flex>
              <Text size={1} muted>
                These tags will cause errors on the website. Click fix to auto-generate a slug from
                the name.
              </Text>
              <Stack space={2}>
                {missingSlugTags.map((tag) => (
                  <Card key={tag._id} padding={3} radius={2} border tone="critical">
                    <Flex align="center" justify="space-between">
                      <Stack space={1}>
                        <Text weight="semibold">{tag.name || '(no name)'}</Text>
                        <Text size={1} muted>
                          Used by {tag.refCount} image{tag.refCount !== 1 ? 's' : ''}
                        </Text>
                      </Stack>
                      <Button
                        text={fixing === tag._id ? 'Fixing…' : 'Fix slug'}
                        tone="positive"
                        mode="ghost"
                        onClick={() => fixMissingSlug(tag)}
                        disabled={!!fixing}
                      />
                    </Flex>
                  </Card>
                ))}
              </Stack>
            </Stack>
          </Card>
        )}

        {/* ── Slug Mismatches ───────────────────────────────────────────────── */}
        {activeTab === 'slug-mismatch' && slugMismatchTags.length > 0 && (
          <Card padding={4} radius={2} border>
            <Stack space={4}>
              <Flex align="center" justify="space-between">
                <Text weight="semibold">Slug does not match name</Text>
                <Button
                  text={
                    fixing === 'all-slug-mismatches'
                      ? 'Fixing…'
                      : `Fix all (${slugMismatchTags.length})`
                  }
                  tone="positive"
                  mode="ghost"
                  onClick={fixAllSlugMismatches}
                  disabled={!!fixing}
                />
              </Flex>
              <Text size={1} muted>
                The slug was likely edited manually or the name was changed after the slug was
                generated. Fix regenerates the slug from the current name.
              </Text>
              <Stack space={2}>
                {slugMismatchTags.map((tag) => (
                  <Card key={tag._id} padding={3} radius={2} border tone="caution">
                    <Flex align="center" justify="space-between">
                      <Stack space={1}>
                        <Text size={1} weight="semibold">
                          {tag.name}
                        </Text>
                        <Text size={0} muted>
                          Slug: <strong>{tag.slug}</strong> → expected:{' '}
                          <strong>{slugify(tag.name)}</strong>
                        </Text>
                      </Stack>
                      <Button
                        text={fixing === tag._id ? 'Fixing…' : 'Fix'}
                        tone="positive"
                        mode="ghost"
                        onClick={() => fixSlugMismatch(tag)}
                        disabled={!!fixing}
                      />
                    </Flex>
                  </Card>
                ))}
              </Stack>
            </Stack>
          </Card>
        )}

        {/* ── Duplicate Tags ────────────────────────────────────────────────── */}
        {activeTab === 'duplicate-tag' && duplicateTags.length > 0 && (
          <Card padding={4} radius={2} border>
            <Stack space={4}>
              <Text weight="semibold">Duplicate tags (same slug)</Text>
              <Text size={1} muted>
                Merge keeps the published tag with the most references and deletes the rest
                (including unpublished drafts).
              </Text>
              <Stack space={3}>
                {duplicateTags.map(([slug, group]) => (
                  <Card key={slug} padding={3} radius={2} border tone="caution">
                    <Stack space={3}>
                      <Flex align="center" justify="space-between">
                        <Text weight="semibold">Slug: {slug}</Text>
                        <Button
                          text={
                            fixing === (group.find((t) => !t.isDraft && !t._id.startsWith('drafts.')) || group[0])._id
                              ? 'Merging…'
                              : `Merge ${group.length} → 1`
                          }
                          tone="positive"
                          mode="ghost"
                          onClick={() => mergeDuplicateTags(group)}
                          disabled={!!fixing}
                        />
                      </Flex>
                      <Stack space={1}>
                        {group.map((tag) => (
                          <Flex key={tag._id} align="center" gap={2}>
                            <Text size={1}>
                              {tag.name}{' '}
                              {(tag.isDraft || tag._id.startsWith('drafts.')) && (
                                <Badge tone="caution" fontSize={0}>
                                  draft
                                </Badge>
                              )}{' '}
                              <Badge tone="default" fontSize={0}>
                                {tag.refCount} ref{tag.refCount !== 1 ? 's' : ''}
                              </Badge>
                            </Text>
                          </Flex>
                        ))}
                      </Stack>
                    </Stack>
                  </Card>
                ))}
              </Stack>
            </Stack>
          </Card>
        )}

        {/* ── Unused Tags ───────────────────────────────────────────────────── */}
        {activeTab === 'orphaned-tag' && orphanedTags.length > 0 && (
          <Card padding={4} radius={2} border>
            <Stack space={4}>
              <Flex align="center" justify="space-between">
                <Text weight="semibold">Unused tags</Text>
                <Button
                  icon={TrashIcon}
                  text={
                    fixing === 'all-orphans'
                      ? 'Deleting…'
                      : `Delete all (${orphanedTags.length})`
                  }
                  tone="critical"
                  mode="ghost"
                  onClick={deleteAllOrphanedTags}
                  disabled={!!fixing}
                />
              </Flex>
              <Text size={1} muted>
                Tags not used by any gallery image. Safe to delete unless you plan to use them
                later.
              </Text>
              <Stack space={2}>
                {orphanedTags.map((tag) => (
                  <Card key={tag._id} padding={3} radius={2} border>
                    <Flex align="center" justify="space-between">
                      <Stack space={1}>
                        <Text size={1}>{tag.name || '(no name)'}</Text>
                        <Text size={0} muted>
                          Slug: {tag.slug || '(none)'}
                        </Text>
                      </Stack>
                      <Button
                        icon={TrashIcon}
                        text={fixing === tag._id ? '…' : 'Delete'}
                        tone="critical"
                        mode="ghost"
                        onClick={() => deleteOrphanedTag(tag)}
                        disabled={!!fixing}
                      />
                    </Flex>
                  </Card>
                ))}
              </Stack>
            </Stack>
          </Card>
        )}

        {/* ── Untagged Images ───────────────────────────────────────────────── */}
        {activeTab === 'untagged-image' && untaggedImages.length > 0 && (
          <Card padding={4} radius={2} border>
            <Stack space={4}>
              <Text weight="semibold">Untagged images ({untaggedImages.length})</Text>
              <Text size={1} muted>
                Images missing an oldschool/newschool tag, an artist name tag, or both. Click an
                image to open it in the Structure tool.
              </Text>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                  gap: 8,
                }}
              >
                {untaggedImages.slice(0, 60).map((img) => {
                  const slugs = (img.tagSlugs || []).filter(Boolean)
                  const hasSpecial = slugs.some((s) => specialSlugs.includes(s))
                  const hasArtist = slugs.some((s) => !specialSlugs.includes(s))
                  return (
                    <Card
                      key={img._id}
                      padding={1}
                      radius={2}
                      border
                      tone="caution"
                      style={{cursor: 'pointer'}}
                      onClick={() =>
                        window.open(
                          `/structure/galleryImage;${img._id}`,
                          '_blank',
                        )
                      }
                    >
                      <Stack space={1}>
                        {img.imageUrl ? (
                          <img
                            src={`${img.imageUrl}?w=200&h=140&fit=crop`}
                            alt={img.caption || ''}
                            style={{
                              width: '100%',
                              height: 90,
                              objectFit: 'cover',
                              borderRadius: 4,
                              display: 'block',
                            }}
                          />
                        ) : (
                          <Box
                            style={{
                              width: '100%',
                              height: 90,
                              background: '#e5e7eb',
                              borderRadius: 4,
                            }}
                          />
                        )}
                        <Flex gap={1} wrap="wrap" padding={1}>
                          {!hasSpecial && (
                            <Badge tone="critical" fontSize={0}>
                              No era
                            </Badge>
                          )}
                          {!hasArtist && (
                            <Badge tone="critical" fontSize={0}>
                              No artist
                            </Badge>
                          )}
                        </Flex>
                      </Stack>
                    </Card>
                  )
                })}
              </div>
              {untaggedImages.length > 60 && (
                <Text size={1} muted>
                  Showing 60 of {untaggedImages.length} — fix some and refresh to see more.
                </Text>
              )}
            </Stack>
          </Card>
        )}

        {/* ── Missing Photo Credit ───────────────────────────────────────── */}
        {activeTab === 'missing-credit' && missingCreditImages.length > 0 && (
          <Card padding={4} radius={2} border>
            <Stack space={4}>
              <Text weight="semibold">Missing photo credit ({missingCreditImages.length})</Text>
              <Text size={1} muted>
                Gallery images without a photographer/source credit. Click to open in Structure tool.
              </Text>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                  gap: 8,
                }}
              >
                {missingCreditImages.slice(0, 80).map((img) => (
                  <Card
                    key={img._id}
                    padding={1}
                    radius={2}
                    border
                    tone="caution"
                    style={{cursor: 'pointer'}}
                    onClick={() =>
                      window.open(`/structure/galleryImage;${img._id}`, '_blank')
                    }
                  >
                    {img.imageUrl ? (
                      <img
                        src={`${img.imageUrl}?w=200&h=140&fit=crop`}
                        alt={img.caption || ''}
                        style={{
                          width: '100%',
                          height: 90,
                          objectFit: 'cover',
                          borderRadius: 4,
                          display: 'block',
                        }}
                      />
                    ) : (
                      <Box
                        style={{
                          width: '100%',
                          height: 90,
                          background: '#e5e7eb',
                          borderRadius: 4,
                        }}
                      />
                    )}
                    {img.caption && (
                      <Box padding={1}>
                        <Text size={0} muted>{img.caption}</Text>
                      </Box>
                    )}
                  </Card>
                ))}
              </div>
              {missingCreditImages.length > 80 && (
                <Text size={1} muted>
                  Showing 80 of {missingCreditImages.length} — fix some and refresh to see more.
                </Text>
              )}
            </Stack>
          </Card>
        )}

        {/* ── Broken References & Orphaned Assets ────────────────────────────── */}
        {activeTab === 'broken-refs' && brokenRefsTotal > 0 && (
          <Card padding={4} radius={2} border>
            <Stack space={5}>
              {/* Broken references */}
              {brokenRefDocs.length > 0 && (
                <Stack space={4}>
                  <Flex align="center" justify="space-between">
                    <Text weight="semibold">
                      Broken references ({brokenRefDocs.length} document{brokenRefDocs.length !== 1 ? 's' : ''})
                    </Text>
                    <Button
                      text={fixing === 'all-broken' ? 'Fixing…' : `Fix all`}
                      tone="positive"
                      mode="ghost"
                      onClick={removeAllBrokenRefs}
                      disabled={!!fixing}
                    />
                  </Flex>
                  <Text size={1} muted>
                    Documents referencing tags, images, or partners that no longer exist. Fix
                    removes the dead references.
                  </Text>
                  <Stack space={2}>
                    {brokenRefDocs.map((doc) => (
                      <Card key={doc._id} padding={3} radius={2} border tone="critical">
                        <Flex align="center" justify="space-between">
                          <Stack space={1}>
                            <Text size={1} weight="semibold">
                              {doc.title || 'Untitled'}
                            </Text>
                            <Text size={0} muted>
                              {doc._type} — {doc.brokenRefs.length} broken ref{doc.brokenRefs.length !== 1 ? 's' : ''}
                            </Text>
                          </Stack>
                          <Button
                            text={fixing === doc._id ? 'Fixing…' : 'Remove dead refs'}
                            tone="positive"
                            mode="ghost"
                            onClick={() => removeBrokenRefs(doc)}
                            disabled={!!fixing}
                          />
                        </Flex>
                      </Card>
                    ))}
                  </Stack>
                </Stack>
              )}

              {/* Orphaned assets */}
              {orphanedAssets.length > 0 && (
                <Stack space={4}>
                  <Flex align="center" justify="space-between">
                    <Text weight="semibold">
                      Orphaned image assets ({orphanedAssets.length})
                    </Text>
                    <Button
                      icon={TrashIcon}
                      text={
                        fixing === 'all-orphan-assets'
                          ? 'Deleting…'
                          : `Delete all`
                      }
                      tone="critical"
                      mode="ghost"
                      onClick={deleteAllOrphanedAssets}
                      disabled={!!fixing}
                    />
                  </Flex>
                  <Text size={1} muted>
                    Image files uploaded to Sanity but not used by any document — not gallery images,
                    event covers, blog posts, partner logos, or the homepage.
                  </Text>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                      gap: 8,
                    }}
                  >
                    {orphanedAssets.slice(0, 60).map((asset) => (
                      <Card key={asset._id} padding={1} radius={2} border>
                        <Stack space={1}>
                          <img
                            src={`${asset.url}?w=200&h=140&fit=crop`}
                            alt=""
                            style={{
                              width: '100%',
                              height: 90,
                              objectFit: 'cover',
                              borderRadius: 4,
                              display: 'block',
                            }}
                          />
                          <Flex padding={1} align="center" justify="space-between">
                            <Text size={0} muted>
                              {(asset.size / 1024 / 1024).toFixed(1)} MB
                            </Text>
                            <Button
                              icon={TrashIcon}
                              mode="ghost"
                              tone="critical"
                              onClick={() => deleteOrphanedAsset(asset)}
                              disabled={!!fixing}
                              padding={1}
                              fontSize={0}
                            />
                          </Flex>
                        </Stack>
                      </Card>
                    ))}
                  </div>
                  {orphanedAssets.length > 60 && (
                    <Text size={1} muted>
                      Showing 60 of {orphanedAssets.length} — delete some and refresh to see more.
                    </Text>
                  )}
                </Stack>
              )}
            </Stack>
          </Card>
        )}

        {/* ── Duplicate Images ──────────────────────────────────────────────── */}
        {activeTab === 'duplicate-image' && duplicateImageGroups.length > 0 && (
          <Card padding={4} radius={2} border>
            <Stack space={4}>
              <Flex align="center" justify="space-between">
                <Text weight="semibold">Duplicate images (same asset)</Text>
                <Button
                  text={
                    fixing === 'all-dupes' && mergeProgress
                      ? `Merging ${mergeProgress.current}/${mergeProgress.total}…`
                      : `Merge all (${duplicateImageGroups.length} groups)`
                  }
                  tone="positive"
                  mode="ghost"
                  onClick={mergeAllDuplicateImages}
                  disabled={!!fixing}
                />
              </Flex>
              <Text size={1} muted>
                Multiple gallery image documents pointing to the same uploaded file. Merge combines
                tags, captions, and credits into one document and repoints all references.
              </Text>
              <Stack space={3}>
                {duplicateImageGroups.map((group, idx) => {
                  const isDone = mergedAssets.has(group.assetRef)
                  const isActive =
                    fixing === 'all-dupes' &&
                    mergeProgress &&
                    mergeProgress.current === idx + 1 &&
                    !isDone
                  return (
                    <Card
                      key={group.assetRef}
                      padding={3}
                      radius={2}
                      border
                      tone={isDone ? 'positive' : 'critical'}
                      style={isDone ? {opacity: 0.6} : undefined}
                    >
                      <Stack space={3}>
                        <Flex align="center" justify="space-between" gap={3}>
                          <Flex align="center" gap={3} style={{minWidth: 0}}>
                            {group.images[0].imageUrl && (
                              <img
                                src={`${group.images[0].imageUrl}?w=80&h=80&fit=crop`}
                                alt=""
                                style={{
                                  width: 60,
                                  height: 60,
                                  objectFit: 'cover',
                                  borderRadius: 4,
                                  flexShrink: 0,
                                }}
                              />
                            )}
                            <Text size={1} weight="semibold">
                              {group.images.length} copies
                            </Text>
                            {isDone && (
                              <Badge tone="positive" fontSize={0}>
                                Merged
                              </Badge>
                            )}
                            {isActive && <Spinner />}
                          </Flex>
                          <Button
                            text={
                              fixing === group.images[0]._id
                                ? 'Merging…'
                                : `Merge ${group.images.length} → 1`
                            }
                            tone="positive"
                            mode="ghost"
                            onClick={() => mergeDuplicateImages(group)}
                            disabled={!!fixing}
                          />
                        </Flex>
                        <Stack space={1}>
                          {group.images.map((img) => (
                            <Text key={img._id} size={0} muted>
                              {img._id.slice(0, 12)}…{' '}
                              {img.caption && `"${img.caption}" `}
                              {img.photoCredit && `📷 ${img.photoCredit} `}
                              {(img.tagIds?.length || 0) > 0 &&
                                `(${img.tagIds.length} tags)`}
                            </Text>
                          ))}
                        </Stack>
                      </Stack>
                    </Card>
                  )
                })}
              </Stack>
            </Stack>
          </Card>
        )}

        {/* ── Unpublished Drafts ────────────────────────────────────────────── */}
        {activeTab === 'unpublished-draft' && drafts.length > 0 && (
          <Card padding={4} radius={2} border>
            <Stack space={4}>
              <Flex align="center" justify="space-between">
                <Text weight="semibold">Unpublished drafts</Text>
                <Flex gap={2}>
                  <Button
                    text={
                      fixing === 'all-drafts' && mergeProgress
                        ? `Publishing ${mergeProgress.current}/${mergeProgress.total}…`
                        : `Publish all non-duplicates (${drafts.filter((d) => !d.hasDuplicate).length})`
                    }
                    tone="positive"
                    mode="ghost"
                    onClick={publishAllDrafts}
                    disabled={!!fixing}
                  />
                </Flex>
              </Flex>
              <Text size={1} muted>
                Draft documents with no published version. Drafts marked as duplicates already have
                a published copy with the same image — these are safe to delete.
              </Text>
              <Stack space={2}>
                {drafts.map((draft) => (
                  <Card
                    key={draft._id}
                    padding={3}
                    radius={2}
                    border
                    tone={draft.hasDuplicate ? 'critical' : 'caution'}
                  >
                    <Flex align="center" justify="space-between" gap={3}>
                      <Flex align="center" gap={3} style={{minWidth: 0}}>
                        {draft.imageUrl && (
                          <img
                            src={`${draft.imageUrl}?w=80&h=80&fit=crop`}
                            alt=""
                            style={{
                              width: 40,
                              height: 40,
                              objectFit: 'cover',
                              borderRadius: 4,
                              flexShrink: 0,
                            }}
                          />
                        )}
                        <Stack space={1}>
                          <Flex align="center" gap={2}>
                            <Text size={1} weight="semibold">
                              {draft.title || 'Untitled'}
                            </Text>
                            {draft.hasDuplicate && (
                              <Badge tone="critical" fontSize={0}>
                                Duplicate — delete recommended
                              </Badge>
                            )}
                          </Flex>
                          <Text size={0} muted>
                            {draft._type}
                          </Text>
                        </Stack>
                      </Flex>
                      <Flex gap={2}>
                        {fixing === draft._id ? (
                          <Spinner />
                        ) : (
                          <>
                            {!draft.hasDuplicate && (
                              <Button
                                text="Publish"
                                tone="positive"
                                mode="ghost"
                                onClick={() => publishDraft(draft)}
                                disabled={!!fixing}
                              />
                            )}
                            <Button
                              icon={TrashIcon}
                              text="Delete"
                              tone="critical"
                              mode="ghost"
                              onClick={() => deleteDraft(draft)}
                              disabled={!!fixing}
                            />
                          </>
                        )}
                      </Flex>
                    </Flex>
                  </Card>
                ))}
              </Stack>
            </Stack>
          </Card>
        )}

        {/* ── Event Gallery Helper ──────────────────────────────────────────── */}
        {activeTab === 'event-gallery' && (
          <Card padding={4} radius={2} border>
            <Stack space={4}>
              <Text weight="semibold">Event gallery helper</Text>
              <Text size={1} muted>
                Select an event, then browse gallery images to add or remove them.
              </Text>

              {/* Event selector */}
              <Stack space={2}>
                <TextInput
                  icon={SearchIcon}
                  placeholder="Search events…"
                  value={eventSearchQuery}
                  onChange={(e) => setEventSearchQuery(e.currentTarget.value)}
                  fontSize={1}
                />
                <Flex gap={2} wrap="wrap">
                  {events
                    .filter((e) =>
                      e.name.toLowerCase().includes(eventSearchQuery.toLowerCase()),
                    )
                    .map((event) => (
                      <Button
                        key={event._id}
                        text={event.name}
                        mode={selectedEventId === event._id ? 'default' : 'ghost'}
                        tone={selectedEventId === event._id ? 'primary' : 'default'}
                        onClick={() => {
                          setSelectedEventId(
                            selectedEventId === event._id ? null : event._id,
                          )
                          setImageSearchQuery('')
                        }}
                        fontSize={1}
                        padding={2}
                      />
                    ))}
                </Flex>
              </Stack>

              {selectedEvent && (() => {
                const filteredImages = images.filter((img) => {
                  if (eventImageIds.has(img._id)) return false
                  if (!imageSearchQuery) return true
                  const q = imageSearchQuery.toLowerCase()
                  return (
                    (img.caption || '').toLowerCase().includes(q) ||
                    (img.photoCredit || '').toLowerCase().includes(q) ||
                    (img.tagSlugs || []).some((s) => s && s.includes(q))
                  )
                })
                const hasMore = filteredImages.length > visibleImageCount
                return (
                <Stack space={3}>
                  {/* Current event images */}
                  <Text size={1} weight="semibold">
                    Current images ({eventImageIds.size})
                  </Text>
                  {eventImageIds.size > 0 ? (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                        gap: 10,
                      }}
                    >
                      {images
                        .filter((img) => eventImageIds.has(img._id))
                        .map((img) => (
                          <Card
                            key={img._id}
                            padding={1}
                            radius={2}
                            border
                            tone="positive"
                            style={{position: 'relative'}}
                          >
                            {img.imageUrl ? (
                              <img
                                src={`${img.imageUrl}?w=300&h=200&fit=crop`}
                                alt={img.caption || ''}
                                style={{
                                  width: '100%',
                                  height: 140,
                                  objectFit: 'cover',
                                  borderRadius: 4,
                                  display: 'block',
                                }}
                              />
                            ) : (
                              <Box
                                style={{
                                  width: '100%',
                                  height: 140,
                                  background: '#e5e7eb',
                                  borderRadius: 4,
                                }}
                              />
                            )}
                            {img.caption && (
                              <Box padding={1}>
                                <Text size={0} muted>{img.caption}</Text>
                              </Box>
                            )}
                            <Button
                              icon={TrashIcon}
                              mode="ghost"
                              tone="critical"
                              onClick={() => removeImageFromEvent(img._id)}
                              disabled={!!fixing}
                              style={{
                                position: 'absolute',
                                top: 6,
                                right: 6,
                                background: 'rgba(255,255,255,0.9)',
                                borderRadius: 4,
                                padding: 2,
                              }}
                            />
                          </Card>
                        ))}
                    </div>
                  ) : (
                    <Text size={1} muted>
                      No images yet.
                    </Text>
                  )}

                  {/* Add images */}
                  <Text size={1} weight="semibold">
                    Add images ({filteredImages.length} available)
                  </Text>
                  <TextInput
                    icon={SearchIcon}
                    placeholder="Filter by caption, credit, or tag…"
                    value={imageSearchQuery}
                    onChange={(e) => {
                      setImageSearchQuery(e.currentTarget.value)
                      setVisibleImageCount(80)
                    }}
                    fontSize={1}
                  />
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                      gap: 10,
                    }}
                  >
                    {filteredImages
                      .slice(0, visibleImageCount)
                      .map((img) => (
                        <Card
                          key={img._id}
                          padding={1}
                          radius={2}
                          border
                          style={{cursor: 'pointer', position: 'relative'}}
                          onClick={() => addImageToEvent(img._id)}
                        >
                          {fixing === img._id ? (
                            <Flex
                              align="center"
                              justify="center"
                              style={{width: '100%', height: 140}}
                            >
                              <Spinner />
                            </Flex>
                          ) : (
                            <>
                              {img.imageUrl ? (
                                <img
                                  src={`${img.imageUrl}?w=300&h=200&fit=crop`}
                                  alt={img.caption || ''}
                                  style={{
                                    width: '100%',
                                    height: 140,
                                    objectFit: 'cover',
                                    borderRadius: 4,
                                    display: 'block',
                                  }}
                                />
                              ) : (
                                <Box
                                  style={{
                                    width: '100%',
                                    height: 140,
                                    background: '#e5e7eb',
                                    borderRadius: 4,
                                  }}
                                />
                              )}
                              {img.caption && (
                                <Box padding={1}>
                                  <Text size={0} muted>{img.caption}</Text>
                                </Box>
                              )}
                              <Box
                                style={{
                                  position: 'absolute',
                                  top: 6,
                                  right: 6,
                                  background: 'rgba(255,255,255,0.9)',
                                  borderRadius: '50%',
                                  width: 24,
                                  height: 24,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                <AddIcon />
                              </Box>
                            </>
                          )}
                        </Card>
                      ))}
                  </div>
                  {hasMore && (
                    <Flex justify="center">
                      <Button
                        text={`Load more (${filteredImages.length - visibleImageCount} remaining)`}
                        mode="ghost"
                        onClick={() => setVisibleImageCount((prev) => prev + 80)}
                      />
                    </Flex>
                  )}
                </Stack>
                )
              })()}
            </Stack>
          </Card>
        )}
      </Stack>
    </Box>
  )
}

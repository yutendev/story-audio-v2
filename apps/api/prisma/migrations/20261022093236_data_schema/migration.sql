/*
  Warnings:

  - You are about to drop the `sanity` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('queued', 'running', 'waiting_quota', 'needs_review', 'failed', 'canceled', 'completed');

-- CreateEnum
CREATE TYPE "ChapterStage" AS ENUM ('discovered', 'downloaded', 'normalized', 'rewritten', 'qa_passed', 'tts_done', 'verified', 'failed');

-- CreateEnum
CREATE TYPE "ReviewState" AS ENUM ('none', 'needs_review', 'approved');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('chapter_text', 'normalized_text', 'rewritten_text', 'chapter_audio', 'm4b', 'mp4', 'thumbnail', 'description');

-- CreateEnum
CREATE TYPE "PackageState" AS ENUM ('pending', 'building', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "JobEventType" AS ENUM ('stage_started', 'progress', 'chapter_status', 'artifact_ready', 'quota_wait', 'needs_review', 'error', 'final');

-- DropTable
DROP TABLE "sanity";

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'queued',
    "config_snapshot" JSONB NOT NULL DEFAULT '{}',
    "chapters_per_book" INTEGER NOT NULL DEFAULT 20,
    "not_before" TIMESTAMP(3),
    "last_error" TEXT,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapters" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "stage_state" "ChapterStage" NOT NULL DEFAULT 'discovered',
    "review_state" "ReviewState" NOT NULL DEFAULT 'none',
    "text_asset_id" TEXT,
    "audio_asset_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "chapter_id" TEXT,
    "package_id" TEXT,
    "kind" "AssetKind" NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "fingerprint" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book_packages" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "start_chapter" INTEGER NOT NULL,
    "end_chapter" INTEGER NOT NULL,
    "chapter_count" INTEGER NOT NULL,
    "grouping_snapshot" JSONB NOT NULL DEFAULT '{}',
    "state" "PackageState" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "chapter_id" TEXT,
    "seq" INTEGER NOT NULL,
    "event_type" "JobEventType" NOT NULL,
    "message" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jobs_state_created_at_idx" ON "jobs"("state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "chapters_text_asset_id_key" ON "chapters"("text_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "chapters_audio_asset_id_key" ON "chapters"("audio_asset_id");

-- CreateIndex
CREATE INDEX "chapters_job_id_stage_state_idx" ON "chapters"("job_id", "stage_state");

-- CreateIndex
CREATE UNIQUE INDEX "chapters_job_id_index_key" ON "chapters"("job_id", "index");

-- CreateIndex
CREATE INDEX "assets_job_id_kind_idx" ON "assets"("job_id", "kind");

-- CreateIndex
CREATE INDEX "assets_chapter_id_idx" ON "assets"("chapter_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_chapter_id_kind_key" ON "assets"("chapter_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "book_packages_job_id_sequence_key" ON "book_packages"("job_id", "sequence");

-- CreateIndex
CREATE INDEX "job_events_job_id_created_at_idx" ON "job_events"("job_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_events_job_id_seq_key" ON "job_events"("job_id", "seq");

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_text_asset_id_fkey" FOREIGN KEY ("text_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_audio_asset_id_fkey" FOREIGN KEY ("audio_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "book_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_packages" ADD CONSTRAINT "book_packages_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

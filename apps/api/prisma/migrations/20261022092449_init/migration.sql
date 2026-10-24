-- CreateTable
CREATE TABLE "sanity" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sanity_pkey" PRIMARY KEY ("id")
);

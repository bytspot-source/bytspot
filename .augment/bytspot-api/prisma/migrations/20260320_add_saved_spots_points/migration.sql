-- CreateTable: saved_spots
CREATE TABLE "saved_spots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_spots_pkey" PRIMARY KEY ("id")
);

-- CreateTable: spot_collections
CREATE TABLE "spot_collections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spot_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable: spot_collection_items
CREATE TABLE "spot_collection_items" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "saved_spot_id" TEXT NOT NULL,

    CONSTRAINT "spot_collection_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable: point_transactions
CREATE TABLE "point_transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: user_achievements
CREATE TABLE "user_achievements" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "achievement_id" TEXT NOT NULL,
    "unlocked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_achievements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "saved_spots_user_id_venue_id_key" ON "saved_spots"("user_id", "venue_id");
CREATE INDEX "saved_spots_user_id_idx" ON "saved_spots"("user_id");

CREATE INDEX "spot_collections_user_id_idx" ON "spot_collections"("user_id");

CREATE UNIQUE INDEX "spot_collection_items_collection_id_saved_spot_id_key" ON "spot_collection_items"("collection_id", "saved_spot_id");

CREATE INDEX "point_transactions_user_id_created_at_idx" ON "point_transactions"("user_id", "created_at" DESC);

CREATE UNIQUE INDEX "user_achievements_user_id_achievement_id_key" ON "user_achievements"("user_id", "achievement_id");
CREATE INDEX "user_achievements_user_id_idx" ON "user_achievements"("user_id");

-- AddForeignKey
ALTER TABLE "saved_spots" ADD CONSTRAINT "saved_spots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "saved_spots" ADD CONSTRAINT "saved_spots_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "spot_collections" ADD CONSTRAINT "spot_collections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "spot_collection_items" ADD CONSTRAINT "spot_collection_items_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "spot_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "spot_collection_items" ADD CONSTRAINT "spot_collection_items_saved_spot_id_fkey" FOREIGN KEY ("saved_spot_id") REFERENCES "saved_spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


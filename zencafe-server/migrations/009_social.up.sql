-- Migration 009: Social - Tier-Aware Chat (UP)
-- Builds on 008_content_and_chat_tiers. See docs/social/README.md.
--
-- SAFETY-CRITICAL DEVIATION FROM PROJECT CONVENTION: everywhere else in this schema,
-- cross-table business rules are deliberately left to the service layer rather than
-- database triggers (see game_passes.active, subscription lapse enforcement). This
-- migration is the one exception: a teen must never be able to friend or message a
-- verified adult, and vice versa. Given the stakes (preventing adult-to-minor contact),
-- this is enforced with actual database triggers, not just a service-layer promise -
-- defense in depth, not a convenience.

CREATE TABLE chat_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cafe_id UUID REFERENCES cafes(id) ON DELETE CASCADE, -- NULL means a global (cross-branch) room
    tier TEXT NOT NULL CHECK (tier IN ('teens', 'adults')), -- kids never get a chat room - no chat at all
    room_type TEXT NOT NULL CHECK (room_type IN ('local', 'global')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT room_scope_consistent CHECK (
        (room_type = 'global' AND cafe_id IS NULL)
        OR
        (room_type = 'local' AND cafe_id IS NOT NULL)
    )
);

-- Exactly one global room per tier (one "global teens", one "global adults")
CREATE UNIQUE INDEX idx_chat_rooms_global_per_tier ON chat_rooms (tier) WHERE room_type = 'global';
-- Exactly one local room per (cafe, tier)
CREATE UNIQUE INDEX idx_chat_rooms_local_per_cafe_tier ON chat_rooms (cafe_id, tier) WHERE room_type = 'local';

CREATE TABLE friends (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, friend_id)
);

CREATE FUNCTION enforce_friend_tier_match() RETURNS TRIGGER AS $$
DECLARE
    requester_tier TEXT;
    target_tier TEXT;
BEGIN
    SELECT verified_chat_tier INTO requester_tier FROM users WHERE id = NEW.user_id;
    SELECT verified_chat_tier INTO target_tier FROM users WHERE id = NEW.friend_id;

    IF requester_tier IS NULL OR target_tier IS NULL THEN
        RAISE EXCEPTION 'Both users must be staff-verified (teens or adults) before becoming friends - kids and unverified accounts cannot use friends/chat';
    END IF;

    IF requester_tier != target_tier THEN
        RAISE EXCEPTION 'Friend tier mismatch: a % account cannot friend a % account (teens only friend teens, adults only friend adults)', requester_tier, target_tier;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_friends_tier_match
    BEFORE INSERT ON friends
    FOR EACH ROW EXECUTE FUNCTION enforce_friend_tier_match();

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES users(id),
    receiver_id UUID REFERENCES users(id), -- set for a direct message
    room_id UUID REFERENCES chat_rooms(id), -- set for a room post
    content TEXT NOT NULL,
    flagged BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A message is either a DM or a room post, never both, never neither
    CONSTRAINT message_target_exclusive CHECK (
        (receiver_id IS NOT NULL AND room_id IS NULL)
        OR
        (receiver_id IS NULL AND room_id IS NOT NULL)
    )
);

CREATE FUNCTION enforce_message_tier_access() RETURNS TRIGGER AS $$
DECLARE
    sender_tier TEXT;
    receiver_tier TEXT;
    target_room_tier TEXT;
BEGIN
    SELECT verified_chat_tier INTO sender_tier FROM users WHERE id = NEW.sender_id;
    IF sender_tier IS NULL THEN
        RAISE EXCEPTION 'Sender is not staff-verified for chat access (kids, or unverified teens/adults, cannot send messages)';
    END IF;

    IF NEW.room_id IS NOT NULL THEN
        SELECT tier INTO target_room_tier FROM chat_rooms WHERE id = NEW.room_id;
        IF target_room_tier IS NULL THEN
            RAISE EXCEPTION 'Target chat room does not exist';
        END IF;
        IF sender_tier != target_room_tier THEN
            RAISE EXCEPTION 'Tier mismatch: a % account cannot post in a % chat room', sender_tier, target_room_tier;
        END IF;
    END IF;

    IF NEW.receiver_id IS NOT NULL THEN
        SELECT verified_chat_tier INTO receiver_tier FROM users WHERE id = NEW.receiver_id;
        IF receiver_tier IS NULL THEN
            RAISE EXCEPTION 'Recipient is not staff-verified for chat access';
        END IF;
        IF sender_tier != receiver_tier THEN
            RAISE EXCEPTION 'Tier mismatch: a % account cannot message a verified % account', sender_tier, receiver_tier;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_messages_tier_check
    BEFORE INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION enforce_message_tier_access();

CREATE INDEX idx_messages_room ON messages (room_id, created_at);
CREATE INDEX idx_messages_receiver ON messages (receiver_id, created_at);

CREATE TABLE reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID NOT NULL REFERENCES users(id),
    reported_user_id UUID NOT NULL REFERENCES users(id),
    message_id UUID REFERENCES messages(id), -- nullable: could report a profile, not just a message
    reason TEXT NOT NULL,
    resolved BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reports_resolved ON reports (resolved, created_at);

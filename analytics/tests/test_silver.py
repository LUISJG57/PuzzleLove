from datetime import date

from pipeline import silver


def test_events_are_deduplicated_flagged_and_localized(spark, events):
    events.add("player_joined", 0, session="s1", client="bot-nova", event_id="dup", name="🤖 Nova", color="#fff", players_in_room=1)
    events.add("player_joined", 0, session="s1", client="bot-nova", event_id="dup", name="🤖 Nova", color="#fff", players_in_room=1)
    # 03:30 UTC is still the previous day (21:30) in Mexico City.
    events.add("player_joined", 9.5 * 3600, session="s2", client="sim-0001", synthetic=True, name="Ana", color="#fff", players_in_room=2)
    rows = {r["client_id"]: r for r in silver.to_silver_events(events.df(spark)).collect()}

    assert len(rows) == 2
    assert rows["bot-nova"]["is_bot"] and not rows["bot-nova"]["is_synthetic"]
    assert rows["sim-0001"]["is_synthetic"] and not rows["sim-0001"]["is_bot"]
    assert rows["sim-0001"]["event_date"] == date(2026, 9, 10)
    assert rows["sim-0001"]["hour_local"] == 21
    assert rows["bot-nova"]["weekday"] == 4  # Thursday


def test_moves_pair_grabs_with_their_outcome(spark, events):
    e = events
    e.add("piece_grabbed", 0, session="s1", client="c1", group_id=3, group_size=1)
    e.add("piece_dropped", 2, session="s1", client="c1", group_id=3, hold_ms=2000, snapped=True, frame=True, merged_groups=1, group_size=2)
    # Grabbing another group abandons the first one.
    e.add("piece_grabbed", 5, session="s1", client="c1", group_id=7, group_size=1)
    e.add("piece_abandoned", 6, session="s1", client="c1", group_id=7, hold_ms=1000, reason="regrab")
    e.add("piece_grabbed", 6, session="s1", client="c1", group_id=8, group_size=4)
    # A different player's events do not close s1's grabs.
    e.add("piece_dropped", 7, session="s2", client="c2", group_id=8, hold_ms=10, snapped=False, frame=False, merged_groups=0, group_size=4)

    evs = silver.to_silver_events(e.df(spark))
    moves = {r["group_id"]: r for r in silver.build_moves(evs).collect()}

    assert moves[3]["outcome"] == "dropped" and moves[3]["snapped"] and moves[3]["merged_groups"] == 1
    assert moves[3]["hold_ms"] == 2000 and moves[3]["group_size_after"] == 2
    assert moves[7]["outcome"] == "abandoned" and moves[7]["abandon_reason"] == "regrab"
    assert moves[8]["outcome"] == "open" and moves[8]["ended_at"] is None and not moves[8]["snapped"]


def test_sessions_pair_joins_with_leaves_and_count_moves(spark, events):
    e = events
    e.add("player_joined", 0, session="s1", client="c1", name="Ana", color="#f00", players_in_room=1)
    e.add("piece_grabbed", 10, session="s1", client="c1", group_id=1, group_size=1)
    e.add("piece_dropped", 11, session="s1", client="c1", group_id=1, hold_ms=1000, snapped=True, frame=False, merged_groups=1, group_size=2)
    e.add("player_left", 60, session="s1", client="c1", reason="disconnect", duration_ms=60000, players_in_room=0)
    e.add("player_joined", 70, session="s3", client="c3", name="Leo", color="#00f", players_in_room=1)

    evs = silver.to_silver_events(e.df(spark))
    moves = silver.build_moves(evs)
    sessions = {r["client_id"]: r for r in silver.build_sessions(evs, moves).collect()}

    assert sessions["c1"]["duration_ms"] == 60000 and sessions["c1"]["left_reason"] == "disconnect"
    assert sessions["c1"]["moves"] == 1 and sessions["c1"]["snaps"] == 1 and sessions["c1"]["player_name"] == "Ana"
    assert sessions["c3"]["left_at"] is None and sessions["c3"]["moves"] == 0

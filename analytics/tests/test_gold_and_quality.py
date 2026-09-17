from pipeline import gold, quality, silver


def build(spark, events):
    evs = silver.to_silver_events(events.df(spark))
    moves = silver.build_moves(evs)
    sessions = silver.build_sessions(evs, moves)
    return evs, moves, sessions


def play_puzzle(e, puzzle, client, merges, pieces, start=0, completed=True, source="create"):
    e.add("puzzle_started", start, puzzle=puzzle, room="r1", room_type="private", rows=2, cols=pieces // 2, pieces=pieces, source=source)
    for i in range(merges):
        t = start + 10 + i * 5
        e.add("piece_grabbed", t, session=f"s-{client}", client=client, puzzle=puzzle, room="r1", room_type="private", group_id=i, group_size=1)
        e.add("piece_dropped", t + 2, session=f"s-{client}", client=client, puzzle=puzzle, room="r1", room_type="private",
              group_id=i, hold_ms=2000, snapped=True, frame=False, merged_groups=1, group_size=i + 2)
    if completed:
        e.add("puzzle_completed", start + 10 + merges * 5, puzzle=puzzle, room="r1", room_type="private", duration_ms=120000,
              pieces=pieces, players_in_room=1, contributors=[{"client_id": client, "name": "Ana", "count": merges}])


def test_fact_puzzle_and_difficulty_funnel(spark, events):
    play_puzzle(events, "r1:1", "c1", merges=3, pieces=4)
    play_puzzle(events, "r1:2", "bot-kiwi", merges=1, pieces=4, start=500, completed=False)
    events.add("puzzle_started", 900, puzzle="r1:3", room="r1", room_type="private", rows=2, cols=2, pieces=4, source="restart")
    evs, moves, _ = build(spark, events)

    facts = {r["puzzle_id"]: r for r in gold.fact_puzzle(evs, moves).collect()}
    assert facts["r1:1"]["is_completed"] and facts["r1:1"]["groups_merged"] == 3 and facts["r1:1"]["traffic_type"] == "human"
    assert facts["r1:1"]["snap_rate"] == 1.0 and facts["r1:1"]["contributors"] == 1 and facts["r1:1"]["date_key"] == 20260910
    assert not facts["r1:2"]["is_completed"] and facts["r1:2"]["traffic_type"] == "bot"
    assert facts["r1:3"]["moves"] == 0 and facts["r1:3"]["traffic_type"] == "none"

    funnel = {r["traffic_type"]: r for r in gold.agg_difficulty(gold.fact_puzzle(evs, moves)).collect()}
    assert funnel["human"]["completed"] == 1 and funnel["human"]["completion_rate"] == 1.0
    assert funnel["bot"]["played"] == 1 and funnel["bot"]["completion_rate"] == 0.0
    assert funnel["none"]["played"] == 0 and funnel["none"]["completion_rate"] is None


def test_dim_date_covers_every_day(spark, events):
    events.add("player_joined", 0, session="s", client="c", name="A", color="#f00", players_in_room=1)
    events.add("player_joined", 3 * 86400, session="t", client="c", name="A", color="#f00", players_in_room=1)
    evs, _, _ = build(spark, events)
    days = gold.dim_date(evs).orderBy("date_key").collect()
    assert [d["date_key"] for d in days] == [20260910, 20260911, 20260912, 20260913]
    assert [d["is_weekend"] for d in days] == [False, False, True, True]


def test_quality_checks_flag_bad_data(spark, events):
    play_puzzle(events, "r1:1", "c1", merges=2, pieces=4)  # completed with 2 merges but needs 3
    events.add("player_joined", 1, session="x", client="c9", event_id="same", name="A", color="#f00", players_in_room=1)
    evs, moves, sessions = build(spark, events)
    bronze = events.df(spark)
    duplicated = evs.unionByName(evs.filter("event_id = 'same'"))

    results = {c.name: c for c in quality.run_checks(bronze, duplicated, moves, sessions, gold.fact_puzzle(evs, moves))}
    assert not results["silver_events_unique_event_id"].passed
    assert not results["bronze_silver_reconciliation"].passed
    assert not results["completed_puzzles_merge_count"].passed
    assert results["silver_events_not_in_future"].passed

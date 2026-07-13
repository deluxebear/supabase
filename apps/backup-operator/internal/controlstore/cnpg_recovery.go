package controlstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/cloudnativepg"
)

type CNPGRecoveryStore struct{ Store *Store }

func (a CNPGRecoveryStore) Ensure(ctx context.Context, planID, sourceUID string, rollbackUntil time.Time) error {
	s:=a.Store;if s==nil{return errors.New("control store is required")}
	if planID == "" || sourceUID == "" || rollbackUntil.IsZero() { return errors.New("CNPG plan, source UID, and rollback deadline are required") }
	query:=`INSERT INTO cnpg_recovery_states(plan_id,source_uid,replacement_uid,phase,rollback_until_ms) VALUES(?,?,?, ?,?) ON CONFLICT(plan_id) DO NOTHING`
	if s.dialect==Postgres{query=`INSERT INTO cnpg_recovery_states(plan_id,source_uid,replacement_uid,phase,rollback_until_ms) VALUES($1,$2,$3,$4,$5) ON CONFLICT(plan_id) DO NOTHING`}
	_,err:=s.db.ExecContext(ctx,query,planID,sourceUID,"",cloudnativepg.PhasePlanned,rollbackUntil.UnixMilli());return err
}
func (a CNPGRecoveryStore) Load(ctx context.Context,planID string)(cloudnativepg.RecoveryState,error){s:=a.Store;if s==nil{return cloudnativepg.RecoveryState{},errors.New("control store is required")}
	query:=`SELECT plan_id,source_uid,replacement_uid,phase,rollback_until_ms FROM cnpg_recovery_states WHERE plan_id=?`;if s.dialect==Postgres{query=`SELECT plan_id,source_uid,replacement_uid,phase,rollback_until_ms FROM cnpg_recovery_states WHERE plan_id=$1`};var state cloudnativepg.RecoveryState;var deadline int64;err:=s.db.QueryRowContext(ctx,query,planID).Scan(&state.PlanID,&state.SourceUID,&state.ReplacementUID,&state.Phase,&deadline);state.RollbackUntil=time.UnixMilli(deadline).UTC();return state,err
}
func (a CNPGRecoveryStore) Transition(ctx context.Context,planID string,from,to cloudnativepg.RecoveryPhase,mutate func(*cloudnativepg.RecoveryState))error{s:=a.Store;if s==nil{return errors.New("control store is required")}
	tx,err:=s.db.BeginTx(ctx,nil);if err!=nil{return err};defer tx.Rollback();query:=`SELECT plan_id,source_uid,replacement_uid,phase,rollback_until_ms FROM cnpg_recovery_states WHERE plan_id=?`;if s.dialect==Postgres{query=`SELECT plan_id,source_uid,replacement_uid,phase,rollback_until_ms FROM cnpg_recovery_states WHERE plan_id=$1 FOR UPDATE`};var state cloudnativepg.RecoveryState;var deadline int64;if err:=tx.QueryRowContext(ctx,query,planID).Scan(&state.PlanID,&state.SourceUID,&state.ReplacementUID,&state.Phase,&deadline);err!=nil{return err};if state.Phase!=from{return errors.New("CNPG recovery state compare-and-swap failed")};state.RollbackUntil=time.UnixMilli(deadline);if mutate!=nil{mutate(&state)};update:=`UPDATE cnpg_recovery_states SET replacement_uid=?,phase=? WHERE plan_id=? AND phase=?`;args:=[]any{state.ReplacementUID,to,planID,from};if s.dialect==Postgres{update=`UPDATE cnpg_recovery_states SET replacement_uid=$1,phase=$2 WHERE plan_id=$3 AND phase=$4`};result,err:=tx.ExecContext(ctx,update,args...);if err!=nil{return err};rows,err:=result.RowsAffected();if err!=nil||rows!=1{if err==nil{err=sql.ErrNoRows};return err};return tx.Commit()
}

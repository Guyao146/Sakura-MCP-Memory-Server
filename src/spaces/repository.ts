import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../database.js';
import { requireSpaceRole } from '../memory/permissions.js';
import type { SpaceRole } from '../memory/types.js';

export class SpaceRepository {
  constructor(private readonly database: Database) {}

  async list(userId: string, agentId?: string) {
    const result = await this.database.query(
      `SELECT s.id,s.type,s.name,s.description,s.created_by,s.auto_extract_enabled,s.auto_merge_enabled,
       s.conflict_detection_enabled,s.privacy_mode,s.created_at,s.updated_at,sm.role
       FROM spaces s JOIN space_members sm ON sm.space_id=s.id
       WHERE sm.user_id=$1 AND s.deleted_at IS NULL
       AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM agent_space_grants asg WHERE asg.agent_id=$2 AND asg.space_id=s.id))
       ORDER BY s.type='personal' DESC,s.name`, [userId, agentId ?? null]);
    return result.rows;
  }

  async create(userId: string, name: string, description: string) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const space = await client.query(
        `INSERT INTO spaces(type,name,description,created_by) VALUES('shared',$1,$2,$3) RETURNING *`, [name, description, userId]);
      await client.query(`INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,'owner')`, [space.rows[0].id, userId]);
      await client.query('COMMIT'); return { ...space.rows[0], role: 'owner' };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async members(userId: string, spaceId: string, limit = 200) {
    await requireSpaceRole(this.database, userId, spaceId, 'viewer');
    const result = await this.database.query(
      `SELECT u.id,u.email,u.display_name,u.avatar_url,sm.role,sm.created_at
       FROM space_members sm JOIN users u ON u.id=sm.user_id WHERE sm.space_id=$1 ORDER BY sm.created_at LIMIT $2`, [spaceId, limit]);
    return result.rows;
  }

  async invite(userId: string, spaceId: string, email: string, role: Exclude<SpaceRole, 'owner'>, expiresInHours: number) {
    const client=await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const space=await client.query('SELECT type FROM spaces WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE',[spaceId]);
      const member=await client.query<{role:SpaceRole}>('SELECT role FROM space_members WHERE space_id=$1 AND user_id=$2',[spaceId,userId]);
      const actorRole=member.rows[0]?.role;
      if(!actorRole||!['owner','admin'].includes(actorRole))throw new Error('Space access denied.');
      if(role==='admin'&&actorRole!=='owner')throw new Error('Only owners may invite administrators.');
      if(space.rows[0]?.type!=='shared')throw new Error('Invitations are only supported for shared spaces.');
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const result = await client.query<{ id: string; expires_at: string }>(
        `INSERT INTO space_invitations(space_id,email,role,invited_by,token_hash,expires_at)
         VALUES($1,lower($2),$3,$4,$5,now()+($6 || ' hours')::interval)
         ON CONFLICT(space_id,lower(email)) WHERE accepted_at IS NULL DO UPDATE
         SET role=EXCLUDED.role,invited_by=EXCLUDED.invited_by,token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,revoked_at=NULL
         RETURNING id,expires_at`, [spaceId, email, role, userId, tokenHash, expiresInHours]);
      await client.query('COMMIT');
      return { invitationId: result.rows[0].id, token, expiresAt: result.rows[0].expires_at };
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  async accept(userId: string, email: string | undefined, token: string) {
    if (!email) throw new Error('Authentik account must provide an email to accept invitations.');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const lookup=await client.query<{space_id:string}>('SELECT space_id FROM space_invitations WHERE token_hash=$1',[tokenHash]);
      if(!lookup.rows[0])throw new Error('Invitation is invalid.');
      const space=await client.query('SELECT id FROM spaces WHERE id=$1 AND deleted_at IS NULL AND type=\'shared\' FOR NO KEY UPDATE',[lookup.rows[0].space_id]);
      if(!space.rows[0])throw new Error('Invitation space is unavailable.');
      const invitation = await client.query<{ id: string; space_id: string; role: SpaceRole; invited_by:string }>(
        `SELECT id,space_id,role,invited_by FROM space_invitations WHERE token_hash=$1 AND lower(email)=lower($2)
         AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`, [tokenHash, email]);
      if (!invitation.rows[0]) throw new Error('Invitation is invalid, expired, already used, or belongs to another email.');
      const sender=await client.query<{role:SpaceRole}>('SELECT role FROM space_members WHERE space_id=$1 AND user_id=$2',[invitation.rows[0].space_id,invitation.rows[0].invited_by]);
      if(!['owner','admin'].includes(sender.rows[0]?.role)||invitation.rows[0].role==='admin'&&sender.rows[0]?.role!=='owner')throw new Error('Invitation issuer no longer has permission.');
      await client.query(
        `INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,$3)
         ON CONFLICT(space_id,user_id) DO NOTHING`,
        [invitation.rows[0].space_id, userId, invitation.rows[0].role]);
      await client.query('UPDATE space_invitations SET accepted_at=now() WHERE id=$1', [invitation.rows[0].id]);
      const memberRole=await client.query<{role:SpaceRole}>('SELECT role FROM space_members WHERE space_id=$1 AND user_id=$2',[invitation.rows[0].space_id,userId]);
      await client.query('COMMIT');
      return { spaceId: invitation.rows[0].space_id, role: memberRole.rows[0]?.role??invitation.rows[0].role };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
package com.academicagent.platform.identity.mapper;

import java.util.List;
import java.util.Optional;

import com.academicagent.platform.identity.entity.UserCredential;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface UserCredentialMapper extends BaseMapper<UserCredential> {

    default List<UserCredential> findByUserId(String userId) {
        return selectList(Wrappers.<UserCredential>lambdaQuery().eq(UserCredential::getUserId, userId));
    }

    default Optional<UserCredential> findByUserIdAndProfile(String userId, String profile) {
        return Optional.ofNullable(selectOne(Wrappers.<UserCredential>lambdaQuery()
                .eq(UserCredential::getUserId, userId)
                .eq(UserCredential::getProfile, profile)));
    }
}

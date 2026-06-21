package com.academicagent.platform.identity.mapper;

import java.util.Optional;

import com.academicagent.platform.identity.entity.User;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface UserMapper extends BaseMapper<User> {

    @Select("SELECT * FROM identity.users WHERE LOWER(email) = LOWER(#{email}) LIMIT 1")
    User selectByEmailIgnoreCase(@Param("email") String email);

    default Optional<User> findByEmailIgnoreCase(String email) {
        return Optional.ofNullable(selectByEmailIgnoreCase(email));
    }

    default boolean existsByEmailIgnoreCase(String email) {
        return selectByEmailIgnoreCase(email) != null;
    }
}
